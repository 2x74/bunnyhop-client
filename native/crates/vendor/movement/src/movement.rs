use crate::accepted_path::{AcceptedPath, MotionSegment};
use crate::{
    CONTENTS_CURRENT_0, CONTENTS_CURRENT_90, CONTENTS_CURRENT_180, CONTENTS_CURRENT_270,
    CONTENTS_CURRENT_DOWN, CONTENTS_CURRENT_UP, CONTENTS_LADDER, CONTENTS_SLIME, CONTENTS_WATER,
    Configuration, Contact, CrouchPhase, Error, Event, FailureKind, GroundState, MASK_CURRENT,
    MAX_COMMAND_MAGNITUDE, MAX_COORDINATE, Mode, MoveCollision, MoverResult, MoverStatus,
    ObserverMode, Operation, PointQueryPurpose, PointQueryRecord, Policy, PreventedCollision, QueryPurpose,
    QueryRecord, State, StateDisposition, StepInput, StepResult, StepStrategy, StuckRecoveryMode,
    Trace, Tracer, WaterSampling, WishState,
};
use playsrc_collision::Hull;

const MAX_BUMPS: usize = 4;
const MAX_CLIP_PLANES: usize = 5;
const STUCK_OFFSETS: usize = 54;

#[derive(Clone, Copy)]
struct PreparedCommand {
    forward_move: f32,
    side_move: f32,
    up_move: f32,
    maximum_speed: f32,
    forward: [f32; 3],
    right: [f32; 3],
}

pub(super) fn step(
    tracer: &impl Tracer,
    mut state: State,
    mut input: StepInput,
    configuration: Configuration,
    policy: Policy,
    observe: bool,
) -> Result<StepResult, Error> {
    validate(state, input, configuration, policy)?;
    let initial_state = state;
    let tick = configuration.tick_interval * configuration.lagged_movement_scale;
    let mut context = QueryContext::new(tracer);
    context.record = configuration.record_queries;
    context.observe = observe;
    let mut events = Vec::new();

    apply_mode_request(&mut state, input.mode_request, policy, &mut events);
    if matches!(state.mode, Mode::Fly | Mode::FlyGravity)
        && matches!(
            state.move_collision,
            MoveCollision::Custom | MoveCollision::Slide
        )
    {
        return Err(Error::new(
            Operation::Move,
            FailureKind::Unsupported,
            "fly-collision-response",
        ));
    }

    // CS:S ReduceTimers / WalkMove / CheckJumpButton:
    // https://github.com/nillerusr/source-engine/blob/ed8209cc35c61fbd8ddff8480962a01c981eef2f/game/shared/cstrike/cs_gamemovement.cpp
    // Stamina stores milliseconds of fatigue, recovers every tick, and is reset (not added) by a jump.
    if configuration.css_stamina {
        state.stamina_ms = (state.stamina_ms - 1000.0 * tick).max(0.0);
    }
    prepare_base_velocity(tracer, &mut state, tick)?;
    let mut command = prepare_command(&mut state, input, configuration, policy);
    let selected_hull = selected_hull(state, configuration, policy)?;
    let mover_result = apply_mover(&mut context, &mut state, selected_hull, configuration)?;

    let mut result = StepResult {
        accepted_path: observe.then(|| AcceptedPath::unsupported("no-supported-movement")),
        ground_detach_by_upward_speed: false,
        state,
        selected_hull,
        wish_state: WishState::default(),
        wish_velocity: [0.0; 3],
        jump_velocity: [0.0; 3],
        climbed_step: 0.0,
        contacts: Vec::new(),
        events,
        queries: Vec::new(),
        point_queries: Vec::new(),
        mover_result,
        air_move_velocity: None,
        move_collided: false,
        prevented_collision: None,
    };

    if mode_checks_stuck(result.state.mode)
        && !check_stuck(
            &mut context,
            &mut result.state,
            input.command_number,
            selected_hull,
            configuration,
            &mut result.contacts,
            &mut result.events,
        )?
    {
        finish_step(&mut result, input, configuration, policy)?;
        result.queries = context.sweeps;
        result.point_queries = context.points;
        return Ok(result);
    }

    if result.state.mode != Mode::Walk || !configuration.optimized_movement || input.game_code_moved {
        let was_grounded = result.state.ground.is_some();
        let landing_velocity = result.state.velocity;
        categorize_position(
            &mut context,
            &mut result.state,
            configuration,
            policy,
            &mut result.contacts,
            &mut result.events,
            &mut result.ground_detach_by_upward_speed,
        )?;
        if result.state.mode == Mode::Walk {
            fix_early_downhill_landing(&mut result.state, was_grounded, landing_velocity, configuration);
        }
    } else if result.state.velocity[2] > 250.0 {
        set_ground(
            &context,
            &mut result.state,
            None,
            &mut result.contacts,
            &mut result.events,
        )?;
    }

    let old_water_level = result.state.water_level;
    let old_water_type = result.state.water_type;
    if result.state.ground.is_none() && result.state.velocity[2] < 0.0 {
        result.state.fall_speed = result.state.fall_speed.max(-result.state.velocity[2]);
    }

    if policy.water.suppress_airborne_duck
        && result.state.water_level >= 1
        && result.state.ground.is_none()
        || policy.water.suppress_submerged_duck && result.state.water_level >= 3
    {
        input.command.crouch = false;
    }

    // bunnyhop patch: CS:S evaluates the duck crop against the duck state *before* this tick's
    // duck update (HandleDuckingSpeedCrop runs at the top of Duck()).
    let crop_before_duck = policy.crouch_command_crop == crate::CrouchCommandCrop::AnyDuckState
        && (input.command.crouch || result.state.crouch.phase != CrouchPhase::Standing);
    let crouch_phase = result.state.crouch.phase;
    let crouch_position = result.state.position;
    let crouch_hull = result.state.crouch.uses_crouched_hull();
    update_crouch(
        &mut context,
        &mut result.state,
        input.command.crouch,
        tick,
        configuration,
        policy,
        &mut result.events,
    )?;
    if policy.recategorize_after_crouch
        && (result.state.position != crouch_position
            || result.state.crouch.uses_crouched_hull() != crouch_hull
            || (crouch_phase != result.state.crouch.phase
                && matches!(result.state.crouch.phase, CrouchPhase::Standing | CrouchPhase::Crouched))) {
        let was_grounded = result.state.ground.is_some();
        let landing_velocity = result.state.velocity;
        categorize_position(&mut context, &mut result.state, configuration, policy,
            &mut result.contacts, &mut result.events, &mut result.ground_detach_by_upward_speed)?;
        if result.state.mode == Mode::Walk {
            fix_early_downhill_landing(&mut result.state, was_grounded, landing_velocity, configuration);
        }
    }
    crop_crouched_command(&result.state, &mut command, policy, crop_before_duck);

    update_ladder(
        &mut context,
        &mut result.state,
        input,
        command,
        configuration,
        policy,
        &mut result.events,
    )?;

    let movement_origin = result.state.position;
    let movement_hull = result.state.active_hull(policy);
    match result.state.mode {
        Mode::None => {}
        Mode::Noclip => noclip(&mut result, input, command, configuration, policy, tick),
        Mode::Walk | Mode::Isometric => full_walk(
            &mut context,
            &mut result,
            input,
            command,
            configuration,
            policy,
            tick,
        )?,
        Mode::Ladder => full_ladder(&mut context, &mut result, configuration, policy, tick)?,
        Mode::Observer => observer_move(
            &mut context,
            &mut result,
            input,
            command,
            configuration,
            policy,
            tick,
        )?,
        Mode::Fly | Mode::FlyGravity => toss_move(
            &mut context,
            &mut result,
            command,
            configuration,
            policy,
            tick,
        )?,
    }

    if old_water_level == 0 && result.state.water_level != 0 {
        result.events.push(Event::WaterEntered {
            level: result.state.water_level,
            contents: result.state.water_type,
        });
    } else if old_water_level != 0 && result.state.water_level == 0 {
        result.events.push(Event::WaterExited {
            previous_level: old_water_level,
            contents: old_water_type,
        });
    }

    finish_step(&mut result, input, configuration, policy)?;
    if observe {
        let path = result.accepted_path.as_mut().unwrap();
        if path.segments.first().is_some_and(|s| s.from == movement_origin)
            && (initial_state.position != movement_origin || initial_state.active_hull(policy) != movement_hull) {
            path.phase_change(initial_state.position, movement_origin, movement_hull, 0.0, true);
        }
        if initial_state.mode != Mode::Walk || result.state.mode != Mode::Walk {
            path.reject("movement-mode");
        } else if initial_state.water_level != 0 || result.state.water_level != 0 || result.state.water_jump_time_ms != 0.0 {
            path.reject("water");
        } else if result.mover_result.is_some() || initial_state.base_velocity != [0.0; 3] {
            path.reject("mover-or-base-velocity");
        } else if result.events.iter().any(|e| matches!(e, Event::Recovered { .. } | Event::Trapped)) {
            path.reject("recovery-or-trapped");
        } else if path.segments.first().is_none_or(|s| s.from != initial_state.position)
            || path.segments.last().is_none_or(|s| s.to != result.state.position) {
            path.reject("position-correction");
        }
    }
    result.queries = context.sweeps;
    result.point_queries = context.points;
    Ok(result)
}

fn finish_step(
    result: &mut StepResult,
    input: StepInput,
    configuration: Configuration,
    policy: Policy,
) -> Result<(), Error> {
    result.state.previous_jump = input.command.jump;
    result.state.previous_crouch = input.command.crouch;
    result.state.previous_forward = input.command.forward;
    result.selected_hull = selected_hull(result.state, configuration, policy)?;
    validate_output(result.state, configuration)
}

fn apply_mode_request(
    state: &mut State,
    request: Option<crate::ModeRequest>,
    policy: Policy,
    events: &mut Vec<Event>,
) {
    let Some(request) = request else { return };
    if request.mode == state.mode {
        return;
    }
    if request.mode == Mode::Noclip && !policy.allow_noclip {
        events.push(Event::ModeDenied {
            requested: request.mode,
        });
        return;
    }
    let from = state.mode;
    if request.disposition.velocity == StateDisposition::Reset {
        state.velocity = [0.0; 3];
        state.base_velocity = [0.0; 3];
        state.base_velocity_applied = false;
    }
    if request.disposition.ground == StateDisposition::Reset {
        state.ground = None;
        state.fall_speed = 0.0;
    }
    if request.disposition.water == StateDisposition::Reset {
        clear_water(state);
    }
    state.mode = request.mode;
    events.push(Event::ModeChanged {
        from,
        to: request.mode,
        disposition: request.disposition,
    });
}

fn prepare_base_velocity(tracer: &impl Tracer, state: &mut State, tick: f32) -> Result<(), Error> {
    let mut applied = state.base_velocity_applied;
    if let Some(support) = state.ground.and_then(|ground| ground.support)
        && let Some(mut conveyor) = tracer.conveyor_velocity(support)?
    {
        if applied {
            conveyor = add(conveyor, state.base_velocity);
        }
        state.base_velocity = conveyor;
        applied = true;
    }
    if !applied && state.base_velocity != [0.0; 3] {
        state.velocity = add(state.velocity, scale(state.base_velocity, 1.0 + tick * 0.5));
        state.base_velocity = [0.0; 3];
    }
    state.base_velocity_applied = false;
    Ok(())
}

fn prepare_command(
    state: &mut State,
    input: StepInput,
    configuration: Configuration,
    policy: Policy,
) -> PreparedCommand {
    let (forward, right, up) = angle_basis(input.pitch_degrees, input.command.yaw_degrees, 0.0);
    let mut maximum_speed = policy.maximum_speed;
    let mut forward_move = input.command.forward;
    let mut side_move = input.command.side;
    let mut up_move = input.up;

    if !matches!(state.mode, Mode::Isometric | Mode::Noclip | Mode::Observer) {
        if configuration.client_max_speed != 0.0 {
            maximum_speed = maximum_speed.min(configuration.client_max_speed);
        }
        let constraint_factor = constraint_speed_factor(
            state.position,
            [forward_move, side_move, up_move],
            [forward, right, up],
            configuration,
        );
        maximum_speed *= configuration
            .surface_max_speed_factor
            .min(constraint_factor);
        let command_speed = length([forward_move, side_move, up_move]);
        if command_speed > maximum_speed && command_speed > 0.0 {
            let factor = maximum_speed / command_speed;
            forward_move *= factor;
            side_move *= factor;
            up_move *= factor;
        }
    }

    state.local_angles = [
        input.pitch_degrees,
        if input.command.yaw_degrees > 180.0 {
            input.command.yaw_degrees - 360.0
        } else {
            input.command.yaw_degrees
        },
        if matches!(state.mode, Mode::Isometric | Mode::Noclip) {
            0.0
        } else {
            movement_roll(
                input.pitch_degrees,
                input.command.yaw_degrees,
                state.velocity,
                configuration.roll_angle,
                configuration.roll_speed,
            )
        },
    ];
    state.absolute_view_angles = [input.pitch_degrees, input.command.yaw_degrees, 0.0];

    PreparedCommand {
        forward_move,
        side_move,
        up_move,
        maximum_speed,
        forward,
        right,
    }
}

fn constraint_speed_factor(
    position: [f32; 3],
    command: [f32; 3],
    basis: [[f32; 3]; 3],
    configuration: Configuration,
) -> f32 {
    let Some(constraint) = configuration.movement_constraint else {
        return 1.0;
    };
    if constraint.radius == 0.0 || constraint.width == 0.0 {
        return 1.0;
    }
    let delta = sub(position, constraint.center);
    let distance_squared = length_squared(delta);
    let inner = constraint.radius - constraint.width;
    if distance_squared <= inner * inner
        || distance_squared >= constraint.radius * constraint.radius
    {
        return 1.0;
    }
    let desired = add(
        add(scale(basis[0], command[0]), scale(basis[1], command[1])),
        scale(basis[2], command[2]),
    );
    if dot(normalized(delta), normalized(desired)) < 0.0 {
        return 1.0;
    }
    let fraction = (distance_squared.sqrt() - inner) / constraint.width;
    1.0 + (constraint.outward_speed_factor - 1.0) * fraction
}

fn selected_hull(
    state: State,
    configuration: Configuration,
    policy: Policy,
) -> Result<Hull, Error> {
    if state.mode == Mode::Observer {
        configuration
            .observer_hull
            .ok_or_else(|| Error::new(Operation::Validate, FailureKind::Missing, "observer-hull"))
    } else {
        Ok(state.active_hull(policy))
    }
}

fn apply_mover(
    context: &mut QueryContext<'_, impl Tracer>,
    state: &mut State,
    hull: Hull,
    configuration: Configuration,
) -> Result<Option<MoverResult>, Error> {
    let support = state.ground.and_then(|ground| ground.support);
    let Some(motion) = context.tracer.mover_motion(state.position, hull, support)? else {
        return Ok(None);
    };
    let grounded = support == Some(motion.identity);
    if !grounded && !motion.swept_contact {
        return Ok(Some(MoverResult {
            identity: motion.identity,
            status: MoverStatus::Moved,
            displacement: [0.0; 3],
            support_velocity: [0.0; 3],
            blocker: None,
        }));
    }

    let destination = add(state.position, motion.displacement);
    let trace = context.trace_without(
        motion.identity,
        QueryPurpose::MoverDisplacement,
        state.position,
        destination,
        hull,
        configuration.solid_mask,
    )?;
    let overlaps = context
        .tracer
        .overlaps_mover(motion.identity, destination, hull)?;
    let blocked = trace.fraction < 1.0 || trace.all_solid || overlaps;
    if blocked && !motion.unblockable {
        return Ok(Some(MoverResult {
            identity: motion.identity,
            status: if trace.all_solid || overlaps {
                MoverStatus::Crushed
            } else {
                MoverStatus::Blocked
            },
            displacement: [0.0; 3],
            support_velocity: [0.0; 3],
            blocker: trace.hit,
        }));
    }

    state.position = if motion.unblockable {
        destination
    } else {
        trace.end
    };
    if grounded {
        state.base_velocity = motion.linear_velocity;
        state.base_velocity_applied = false;
    }
    state.local_angles = add(
        state.local_angles,
        scale(motion.angular_velocity, configuration.tick_interval),
    );
    state.absolute_view_angles = add(
        state.absolute_view_angles,
        scale(motion.angular_velocity, configuration.tick_interval),
    );
    Ok(Some(MoverResult {
        identity: motion.identity,
        status: MoverStatus::Moved,
        displacement: motion.displacement,
        support_velocity: if grounded {
            motion.linear_velocity
        } else {
            [0.0; 3]
        },
        blocker: None,
    }))
}

fn mode_checks_stuck(mode: Mode) -> bool {
    !matches!(
        mode,
        Mode::Noclip | Mode::None | Mode::Isometric | Mode::Observer
    )
}

fn check_stuck(
    context: &mut QueryContext<'_, impl Tracer>,
    state: &mut State,
    command_number: u32,
    hull: Hull,
    configuration: Configuration,
    contacts: &mut Vec<Contact>,
    events: &mut Vec<Event>,
) -> Result<bool, Error> {
    let interval_seconds = if configuration.single_player {
        configuration.stuck_singleplayer_interval
    } else {
        configuration.stuck_multiplayer_interval
    };
    let interval = if state.stuck_offset != 0 {
        1
    } else {
        ((interval_seconds / configuration.tick_interval) as u32).max(1)
    };
    if configuration.optimized_movement
        && !command_number
            .wrapping_add(state.player_identity)
            .is_multiple_of(interval)
    {
        return Ok(true);
    }

    let initial = context.trace(
        QueryPurpose::InitialPosition,
        state.position,
        state.position,
        hull,
        configuration.solid_mask,
    )?;
    if !is_embedded(initial, configuration.solid_mask) {
        state.stuck_offset = 0;
        return Ok(true);
    }

    if configuration.stuck_recovery == StuckRecoveryMode::ClientWorld
        && initial.hit.is_none_or(|hit| context.tracer.is_world(hit))
    {
        state.stuck_offset = 0;
        for (index, offset) in stuck_offsets().into_iter().enumerate() {
            let candidate = add(state.position, offset);
            let trace = context.trace(
                QueryPurpose::StuckRecovery,
                candidate,
                candidate,
                hull,
                configuration.solid_mask,
            )?;
            if !is_embedded(trace, configuration.solid_mask) {
                state.position = candidate;
                state.stuck_offset = 0;
                events.push(Event::Recovered {
                    offset: index as u8,
                });
                return Ok(true);
            }
        }
    }

    let now = context
        .tracer
        .movement_time()
        .ok_or_else(|| Error::new(Operation::Move, FailureKind::Missing, "stuck-movement-time"))?;
    if !now.is_finite() {
        return Err(Error::new(
            Operation::Move,
            FailureKind::Malformed,
            "stuck-movement-time",
        )
        .with_value(now, None));
    }
    if state.stuck_next_check_time >= now - configuration.stuck_retry_seconds {
        record_contact(contacts, initial, state.velocity);
        events.push(Event::Trapped);
        return Ok(false);
    }
    state.stuck_next_check_time = now;
    record_contact(contacts, initial, state.velocity);
    let index = state.stuck_offset as usize % STUCK_OFFSETS;
    state.stuck_offset = ((index + 1) % STUCK_OFFSETS) as u8;
    let candidate = add(state.position, stuck_offsets()[index]);
    let trace = context.trace(
        QueryPurpose::StuckRecovery,
        candidate,
        candidate,
        hull,
        configuration.solid_mask,
    )?;
    if !is_embedded(trace, configuration.solid_mask) {
        state.position = candidate;
        state.stuck_offset = 0;
        events.push(Event::Recovered {
            offset: index as u8,
        });
        return Ok(true);
    }
    events.push(Event::Trapped);
    Ok(false)
}

fn is_embedded(trace: Trace, mask: u32) -> bool {
    trace.start_solid || trace.all_solid || trace.contents & mask != 0 && trace.hit.is_some()
}

fn update_crouch(
    context: &mut QueryContext<'_, impl Tracer>,
    state: &mut State,
    crouch_command: bool,
    tick: f32,
    configuration: Configuration,
    policy: Policy,
    events: &mut Vec<Event>,
) -> Result<(), Error> {
    let before = state.crouch.phase;
    let grounded = state.ground.is_some();
    let desired = crouch_command && policy.allow_duck;

    if !grounded {
        if desired && !state.crouch.uses_crouched_hull() {
            state.position = add(state.position, air_crouch_delta(policy));
            state.crouch = crate::CrouchState::CROUCHED;
        } else if !desired && state.crouch.uses_crouched_hull() {
            if can_unduck(context, *state, false, configuration, policy)? {
                state.position = sub(state.position, air_crouch_delta(policy));
                state.crouch = crate::CrouchState::STANDING;
            } else {
                state.crouch = crate::CrouchState {
                    phase: CrouchPhase::Blocked,
                    fraction: 1.0,
                    linear_fraction: 1.0,
                    start_fraction: 1.0,
                    elapsed: 0.0,
                    duration: policy.unduck_duration,
                };
            }
        } else if !desired
            && policy.air_unduck_from_transition
            && matches!(state.crouch.phase, CrouchPhase::Ducking | CrouchPhase::Unducking)
        {
            // bunnyhop patch: CS:S FinishUnDuck from a partial transition (see `Policy::air_unduck_from_transition`).
            if can_unduck(context, *state, false, configuration, policy)? {
                state.position = sub(state.position, air_crouch_delta(policy));
                state.crouch = crate::CrouchState::STANDING;
            }
        } else if !desired && state.crouch.phase == CrouchPhase::Ducking {
            state.crouch = crate::CrouchState::STANDING;
        }
        update_view(state, policy);
        record_crouch_change(before, state.crouch.phase, events);
        return Ok(());
    }

    let reversing = matches!(state.crouch.phase, CrouchPhase::Ducking) && !desired
        || matches!(state.crouch.phase, CrouchPhase::Unducking) && desired;
    if !reversing {
        advance_crouch(state, tick, policy);
    }
    match state.crouch.phase {
        CrouchPhase::Standing if desired => begin_crouch(state, CrouchPhase::Ducking, policy),
        CrouchPhase::Ducking if !desired => begin_crouch(state, CrouchPhase::Unducking, policy),
        CrouchPhase::Crouched if !desired => {
            if can_unduck(context, *state, true, configuration, policy)? {
                begin_crouch(state, CrouchPhase::Unducking, policy);
            } else {
                state.crouch.phase = CrouchPhase::Blocked;
                state.crouch.fraction = 1.0;
                state.crouch.linear_fraction = 1.0;
            }
        }
        // bunnyhop patch: pressing duck again while unducking from a full duck (FL_DUCKING still
        // set) finishes the duck at once in the SDK (`bInDuck` -> FinishDuck); re-entering the
        // Ducking phase would switch to the standing hull with no CanUnduck check.
        CrouchPhase::Unducking if desired && state.crouch.uses_crouched_hull() => {
            state.crouch = crate::CrouchState::CROUCHED;
        }
        CrouchPhase::Unducking if desired => begin_crouch(state, CrouchPhase::Ducking, policy),
        CrouchPhase::Unducking if !can_unduck(context, *state, true, configuration, policy)? => {
            state.crouch = crate::CrouchState {
                phase: CrouchPhase::Blocked,
                fraction: 1.0,
                linear_fraction: 1.0,
                start_fraction: 1.0,
                elapsed: 0.0,
                duration: policy.unduck_duration,
            };
        }
        CrouchPhase::Blocked if desired => state.crouch = crate::CrouchState::CROUCHED,
        CrouchPhase::Blocked if can_unduck(context, *state, true, configuration, policy)? => {
            begin_crouch(state, CrouchPhase::Unducking, policy);
        }
        CrouchPhase::Blocked => {}
        _ => {}
    }
    update_view(state, policy);
    record_crouch_change(before, state.crouch.phase, events);
    Ok(())
}

fn begin_crouch(state: &mut State, phase: CrouchPhase, policy: Policy) {
    state.crouch.phase = phase;
    state.crouch.start_fraction = state.crouch.fraction;
    state.crouch.elapsed = 0.0;
    state.crouch.duration = if phase == CrouchPhase::Ducking {
        policy.duck_duration * (1.0 - state.crouch.linear_fraction)
    } else {
        policy.unduck_duration * state.crouch.linear_fraction
    };
}

fn advance_crouch(state: &mut State, tick: f32, policy: Policy) {
    match state.crouch.phase {
        CrouchPhase::Ducking => {
            if policy.duck_duration == 0.0 {
                state.crouch.linear_fraction = 1.0;
            } else {
                state.crouch.linear_fraction =
                    (state.crouch.linear_fraction + tick / policy.duck_duration).min(1.0);
                // bunnyhop patch: the engine times ducks in integer milliseconds (m_flDucktime -= 10 per tick);
                // 40 f32 steps of 0.025 end at 0.99999994 and would finish the duck a tick late (tools/parity).
                if state.crouch.linear_fraction > 1.0 - 1e-5 {
                    state.crouch.linear_fraction = 1.0;
                }
            }
            state.crouch.elapsed += tick;
            state.crouch.fraction = simple_spline(state.crouch.linear_fraction);
            if state.crouch.linear_fraction >= 1.0 {
                let origin_delta = sub(policy.crouched_hull.mins, policy.standing_hull.mins);
                state.position = sub(state.position, origin_delta);
                state.crouch = crate::CrouchState::CROUCHED;
            }
        }
        CrouchPhase::Unducking => {
            if policy.unduck_duration == 0.0 {
                state.crouch.linear_fraction = 0.0;
            } else {
                state.crouch.linear_fraction =
                    (state.crouch.linear_fraction - tick / policy.unduck_duration).max(0.0);
                if state.crouch.linear_fraction < 1e-5 {
                    state.crouch.linear_fraction = 0.0;
                }
            }
            state.crouch.elapsed += tick;
            state.crouch.fraction = simple_spline(state.crouch.linear_fraction);
            if state.crouch.linear_fraction <= 0.0 {
                let origin_delta = sub(policy.crouched_hull.mins, policy.standing_hull.mins);
                state.position = add(state.position, origin_delta);
                state.crouch = crate::CrouchState::STANDING;
            }
        }
        _ => {}
    }
}

fn can_unduck(
    context: &mut QueryContext<'_, impl Tracer>,
    state: State,
    grounded: bool,
    configuration: Configuration,
    policy: Policy,
) -> Result<bool, Error> {
    let destination = if grounded {
        add(
            state.position,
            sub(policy.crouched_hull.mins, policy.standing_hull.mins),
        )
    } else {
        sub(state.position, air_crouch_delta(policy))
    };
    let trace = context.trace(
        QueryPurpose::Unduck,
        state.position,
        destination,
        policy.standing_hull,
        configuration.solid_mask,
    )?;
    if trace.start_solid || trace.all_solid || trace.fraction != 1.0 {
        return Ok(false);
    }
    if policy.unduck_checks_destination {
        let stationary = context.trace(
            QueryPurpose::Unduck,
            destination,
            destination,
            policy.standing_hull,
            configuration.solid_mask,
        )?;
        if stationary.start_solid || stationary.all_solid {
            return Ok(false);
        }
    }
    Ok(true)
}

/// bunnyhop patch: origin offset applied by an airborne duck/unduck (see `Policy::air_crouch_lift`).
fn air_crouch_delta(policy: Policy) -> [f32; 3] {
    match policy.air_crouch_lift {
        Some(lift) => [0.0, 0.0, lift],
        None => hull_size_delta(policy),
    }
}

fn hull_size_delta(policy: Policy) -> [f32; 3] {
    sub(
        sub(policy.standing_hull.maxs, policy.standing_hull.mins),
        sub(policy.crouched_hull.maxs, policy.crouched_hull.mins),
    )
}

fn update_view(state: &mut State, policy: Policy) {
    for axis in 0..3 {
        state.view_offset[axis] = policy.standing_view[axis]
            + (policy.crouched_view[axis] - policy.standing_view[axis]) * state.crouch.fraction;
    }
}

fn record_crouch_change(before: CrouchPhase, after: CrouchPhase, events: &mut Vec<Event>) {
    if before != after {
        events.push(Event::CrouchChanged {
            from: before,
            to: after,
        });
    }
}

fn crop_crouched_command(
    state: &State,
    command: &mut PreparedCommand,
    policy: Policy,
    crop_before_duck: bool,
) {
    let crop = match policy.crouch_command_crop {
        crate::CrouchCommandCrop::GroundedCrouched => {
            state.ground.is_some() && state.crouch.uses_crouched_hull()
        }
        crate::CrouchCommandCrop::AnyDuckState => crop_before_duck,
    };
    if crop {
        command.forward_move *= policy.crouched_command_factor;
        command.side_move *= policy.crouched_command_factor;
        command.up_move *= policy.crouched_command_factor;
    }
}

fn update_ladder(
    context: &mut QueryContext<'_, impl Tracer>,
    state: &mut State,
    input: StepInput,
    command: PreparedCommand,
    configuration: Configuration,
    policy: Policy,
    events: &mut Vec<Event>,
) -> Result<(), Error> {
    if state.mode == Mode::Noclip {
        return Ok(());
    }
    if !configuration.ladders_enabled {
        if state.mode == Mode::Ladder {
            state.mode = Mode::Walk;
            state.ladder_normal = [0.0; 3];
            events.push(Event::LadderDetached);
        }
        return Ok(());
    }

    let wish_direction = if state.mode == Mode::Ladder {
        scale(state.ladder_normal, -1.0)
    } else {
        let wish = add(
            scale(command.forward, command.forward_move),
            scale(command.right, command.side_move),
        );
        if length_squared(wish) == 0.0 {
            return Ok(());
        }
        normalized(wish)
    };
    // bunnyhop patch (`Policy::cs_ladders`): CCSGameMovement::LadderDistance (10 while already on a ladder, else 2)
    // and LadderMask (MASK_PLAYERSOLID without CONTENTS_PLAYERCLIP).
    let (ladder_distance, ladder_mask) = if policy.cs_ladders {
        (if state.mode == Mode::Ladder { 10.0 } else { configuration.ladder_distance }, configuration.ladder_mask & !0x0001_0000)
    } else {
        (configuration.ladder_distance, configuration.ladder_mask)
    };
    let destination = add(state.position, scale(wish_direction, ladder_distance));
    let hull = state.active_hull(policy);
    let trace = context.trace(
        QueryPurpose::Ladder,
        state.position,
        destination,
        hull,
        ladder_mask,
    )?;
    // bunnyhop patch: a start-solid hit has no plane; the SDK would attach with a zero ladder
    // normal (and freeze), the port used to fail the whole step. Treat it as no ladder.
    // bunnyhop patch (`cs_ladders`): CCSGameMovement::OnLadder rejects a flat (normal z 1) top face.
    let on_ladder = trace.fraction < 1.0
        && trace.normal.is_some_and(|n| !policy.cs_ladders || n[2] != 1.0)
        && (trace.contents & CONTENTS_LADDER != 0 || context.tracer.surface_climbable(trace.hit));
    if !on_ladder {
        if state.mode == Mode::Ladder {
            state.mode = Mode::Walk;
            state.ladder_normal = [0.0; 3];
            events.push(Event::LadderDetached);
        }
        return Ok(());
    }

    let was_ladder = state.mode == Mode::Ladder;
    state.mode = Mode::Ladder;
    state.move_collision = MoveCollision::Default;
    state.ladder_normal = trace
        .normal
        .ok_or_else(|| Error::new(Operation::Trace, FailureKind::Missing, "ladder-plane"))?;
    if !was_ladder {
        events.push(Event::LadderAttached);
    }

    let floor_point = [
        state.position[0],
        state.position[1],
        state.position[2] + hull.mins[2] - 1.0,
    ];
    let floor_contents = context.point(PointQueryPurpose::LadderFloor, floor_point)?;
    let on_floor = floor_contents == 1 || state.ground.is_some();
    // bunnyhop patch (`cs_ladders`): the SDK builds the speeds from IN_FORWARD / IN_BACK / IN_MOVELEFT / IN_MOVERIGHT,
    // so an unpressed axis is 0 (`f32::signum(0.0)` is 1: W climbed like W+D), and CCSGameMovement::ClimbSpeed is
    // x0.34 while ducking.
    let (forward_speed, right_speed) = if policy.cs_ladders {
        let sgn = |v: f32| if v > 0.0 { 1.0 } else if v < 0.0 { -1.0 } else { 0.0 };
        let climb = if input.command.crouch { configuration.ladder_speed * 0.34 } else { configuration.ladder_speed };
        (sgn(command.forward_move) * climb, sgn(command.side_move) * climb)
    } else {
        (command.forward_move.signum() * configuration.ladder_speed, command.side_move.signum() * configuration.ladder_speed)
    };
    if input.command.jump {
        state.mode = Mode::Walk;
        state.move_collision = MoveCollision::Default;
        state.velocity = scale(state.ladder_normal, configuration.ladder_jump_speed);
        state.ladder_normal = [0.0; 3];
        events.push(Event::LadderDetached);
        return Ok(());
    }
    if forward_speed == 0.0 && right_speed == 0.0 {
        state.velocity = [0.0; 3];
        return Ok(());
    }

    let intended = add(
        scale(command.forward, forward_speed),
        scale(
            command.right,
            right_speed * configuration.ladder_lateral_factor,
        ),
    );
    let horizontal_perpendicular = normalized(cross([0.0, 0.0, 1.0], state.ladder_normal));
    let into_speed = dot(intended, state.ladder_normal);
    let into = scale(state.ladder_normal, into_speed);
    let mut lateral = sub(intended, into);
    let ladder_up = cross(state.ladder_normal, horizontal_perpendicular);
    // bunnyhop patch (`cs_ladders`): CS:S "make ladders easier to climb" (sv_ladder_dampen 0.2, sv_ladder_angle
    // -0.707): looking mostly into the ladder cuts the sideways part of the lateral move to 20%.
    if policy.cs_ladders {
        let tmp_dist = dot(ladder_up, lateral);
        let perp_dist = dot(horizontal_perpendicular, lateral);
        let angle_vec = normalized(add(scale(horizontal_perpendicular, perp_dist), into));
        if dot(angle_vec, state.ladder_normal) < -0.707 {
            lateral = add(scale(ladder_up, tmp_dist), scale(horizontal_perpendicular, 0.2 * perp_dist));
        }
    }
    state.velocity = add(lateral, scale(ladder_up, -into_speed));
    if on_floor && into_speed > 0.0 {
        state.velocity = add(
            state.velocity,
            scale(state.ladder_normal, configuration.ladder_speed),
        );
    }
    Ok(())
}

fn full_ladder(
    context: &mut QueryContext<'_, impl Tracer>,
    result: &mut StepResult,
    configuration: Configuration,
    policy: Policy,
    tick: f32,
) -> Result<(), Error> {
    check_water(context, &mut result.state, configuration, policy)?;
    let hull = result.state.active_hull(policy);
    let total_velocity = add(result.state.velocity, result.state.base_velocity);
    let movement = slide(
        context,
        result.state.position,
        total_velocity,
        hull,
        configuration,
        tick,
        false,
        result.state.ground.is_none(),
        QueryPurpose::Displacement,
        surface_friction(result.state, policy),
    )?;
    result.state.position = movement.position;
    result.state.velocity = sub(movement.velocity, result.state.base_velocity);
    result.contacts.extend(movement.contacts);
    if movement.trapped {
        result.state.velocity = [0.0; 3];
        result.events.push(Event::Trapped);
    }
    Ok(())
}

fn full_walk(
    context: &mut QueryContext<'_, impl Tracer>,
    result: &mut StepResult,
    input: StepInput,
    command: PreparedCommand,
    configuration: Configuration,
    policy: Policy,
    tick: f32,
) -> Result<(), Error> {
    let swimming = if policy.water.refresh_before_walk {
        check_water(context, &mut result.state, configuration, policy)?
    } else {
        result.state.water_level > 1
    };
    if !swimming {
        start_gravity(&mut result.state, configuration, tick);
    }

    if result.state.water_jump_time_ms != 0.0 {
        water_jump(&mut result.state, configuration, policy, tick);
        let hull = result.state.active_hull(policy);
        let movement = slide(
            context,
            result.state.position,
            result.state.velocity,
            hull,
            configuration,
            tick,
            false,
            true,
            QueryPurpose::Displacement,
            surface_friction(result.state, policy),
        )?;
        apply_move_outcome(result, movement);
        check_water(context, &mut result.state, configuration, policy)?;
        return Ok(());
    }

    if result.state.water_level >= 2 {
        if result.state.water_level == 2 {
            check_water_exit(context, result, input, command, configuration, policy)?;
        }
        if result.state.velocity[2] < 0.0 && result.state.water_jump_time_ms != 0.0 {
            result.state.water_jump_time_ms = 0.0;
        }
        check_jump(context, result, input, command, configuration, policy, tick)?;
        water_move(context, result, input, command, configuration, policy, tick)?;
        categorize_position(
            context,
            &mut result.state,
            configuration,
            policy,
            &mut result.contacts,
            &mut result.events,
            &mut result.ground_detach_by_upward_speed,
        )?;
        if result.state.ground.is_some() {
            result.state.velocity[2] = 0.0;
        }
        return Ok(());
    }

    check_jump(context, result, input, command, configuration, policy, tick)?;
    let movement_surface_friction = surface_friction(result.state, policy);
    if result.state.ground.is_some() {
        result.state.velocity[2] = 0.0;
        let friction_wish = ground_friction(
            &mut result.state.velocity,
            configuration,
            movement_surface_friction,
            result.state.water_jump_time_ms,
            tick,
        );
        result.wish_velocity = add(result.wish_velocity, friction_wish);
    }
    clamp_velocity(&mut result.state.velocity, configuration.maximum_velocity);

    let wish = horizontal_wish(command);
    result.wish_state = wish;
    if result.state.ground.is_some() {
        if configuration.css_stamina && result.state.stamina_ms > 0.0 {
            let ratio = playsrc_collision::math::pow((100.0 - (result.state.stamina_ms / 1000.0 * 19.0)) / 100.0, tick / (1.0 / 70.0));
            result.state.velocity[0] *= ratio;
            result.state.velocity[1] *= ratio;
        }
        accelerate(
            &mut result.state.velocity,
            wish.direction,
            wish.speed,
            configuration.acceleration,
            tick,
            movement_surface_friction,
        );
        result.wish_velocity = add(result.wish_velocity, scale(wish.direction, wish.speed));
        if policy.clamp_ground_speed {
            cap_horizontal_speed(&mut result.state.velocity, command.maximum_speed);
        }
        let flat_forward = normalized([command.forward[0], command.forward[1], 0.0]);
        let flat_right = normalized([command.right[0], command.right[1], 0.0]);
        clamp_backward_speed(
            &mut result.state.velocity,
            flat_forward,
            flat_right,
            command.maximum_speed,
            policy,
        );
    } else {
        let applied = air_accelerate(
            &mut result.state.velocity,
            wish.direction,
            wish.speed,
            configuration.air_acceleration,
            policy.air_speed_cap,
            tick,
            movement_surface_friction,
        );
        result.wish_velocity = add(result.wish_velocity, applied);
    }

    let hull = result.state.active_hull(policy);
    let grounded_before_move = result.state.ground.is_some();
    let total_velocity = add(result.state.velocity, result.state.base_velocity);
    // The base velocity this move used (StartGravity zeroed its z): RNGFix's `g_vLastBaseVelocity`.
    let move_base_velocity = result.state.base_velocity;
    let mut move_start = result.state.position;
    if !grounded_before_move {
        result.air_move_velocity = Some(result.state.velocity);
        // bunnyhop patch: RNGFix's pre-tick collision prediction (see `MovementFixes::rngfix_incline` / `rngfix_edge`).
        if configuration.fixes.rngfix_incline || configuration.fixes.rngfix_edge {
            if let Some((start, fix)) =
                rngfix_prevent_collision(context, move_start, total_velocity, hull, configuration, policy, tick)?
            {
                move_start = start;
                result.prevented_collision = Some(fix);
            }
        }
    }
    let movement = if grounded_before_move {
        walk_move(
            context,
            result.state.position,
            total_velocity,
            hull,
            configuration,
            policy.step_strategy,
            tick,
            movement_surface_friction,
        )?
    } else {
        slide(
            context,
            move_start,
            total_velocity,
            hull,
            configuration,
            tick,
            true,
            true,
            QueryPurpose::Displacement,
            movement_surface_friction,
        )?
    };
    if !grounded_before_move {
        // A prevented collision is not one (the plugin clears `g_iLastCollisionTick`), whatever the moved start hits.
        result.move_collided = result.prevented_collision.is_none() && !movement.contacts.is_empty();
    }
    let move_contacts_start = result.contacts.len();
    apply_move_outcome(result, movement);
    result.state.velocity = sub(result.state.velocity, result.state.base_velocity);

    let was_grounded = result.state.ground.is_some();
    let pre_categorize_velocity = result.state.velocity;
    let pre_categorize_position = result.state.position;
    categorize_position(
        context,
        &mut result.state,
        configuration,
        policy,
        &mut result.contacts,
        &mut result.events,
        &mut result.ground_detach_by_upward_speed,
    )?;
    if pre_categorize_position != result.state.position {
        if let Some(p) = &mut result.accepted_path {
            p.phase_change(pre_categorize_position, result.state.position, hull, 1.0, false);
        }
    }
    // bunnyhop patch: downhill landing fix (see `MovementFixes::downhill`).
    if configuration.fixes.rngfix_incline {
        fix_downhill_landing_rngfix(&mut result.state, was_grounded, pre_categorize_velocity, move_base_velocity,
            result.move_collided, configuration);
    } else {
        fix_downhill_landing(&mut result.state, was_grounded, pre_categorize_velocity,
            &result.contacts[move_contacts_start..], configuration);
    }
    clamp_velocity(&mut result.state.velocity, configuration.maximum_velocity);
    let swimming = if policy.water.refresh_before_walk {
        check_water(context, &mut result.state, configuration, policy)?
    } else {
        result.state.water_level > 1
    };
    if !swimming {
        finish_gravity(&mut result.state, configuration, tick);
    }
    if result.state.ground.is_some() && result.state.velocity[2] < 0.0 {
        result.state.velocity[2] = 0.0;
    }
    if result.state.ground.is_none() && result.state.velocity[2] < 0.0 {
        result.state.fall_speed = result.state.fall_speed.max(-result.state.velocity[2]);
    } else if !was_grounded && result.state.ground.is_some() {
        land(context, result, configuration)?;
    }
    clamp_velocity(&mut result.state.velocity, configuration.maximum_velocity);
    Ok(())
}

/// Ground probes can land before movement (including before CheckJumpButton), after ducking,
/// or after displacement. Preserve the falling velocity before SetGround clears its Z.
fn fix_downhill_landing(
    state: &mut State,
    was_grounded: bool,
    landing_velocity: [f32; 3],
    move_contacts: &[Contact],
    configuration: Configuration,
) {
    if configuration.fixes.downhill
        && !was_grounded
        && landing_velocity[2] <= 0.0
        && state.water_level <= 1
        && let Some(ground) = state.ground
        && ground.normal[2] < 1.0
        && !move_contacts.iter().any(|contact| dot(contact.normal, ground.normal) > 0.99)
    {
        let clipped = clip_velocity(landing_velocity, ground.normal, 1.0, configuration.clip_push_out);
        let speed = |v: [f32; 3]| v[0] * v[0] + v[1] * v[1];
        if speed(clipped) > speed(landing_velocity) {
            state.velocity[0] = clipped[0];
            state.velocity[1] = clipped[1];
        }
    }
}

/// A landing by a ground probe before the move (game code moved the player, or a finished duck / unduck): the
/// downhill fix with no move contacts; with `rngfix_incline`, the plugin's variant with this tick's horizontal base
/// velocity.
fn fix_early_downhill_landing(state: &mut State, was_grounded: bool, landing_velocity: [f32; 3], configuration: Configuration) {
    if configuration.fixes.rngfix_incline {
        let base = [state.base_velocity[0], state.base_velocity[1], 0.0];
        fix_downhill_landing_rngfix(state, was_grounded, landing_velocity, base, false, configuration);
    } else {
        fix_downhill_landing(state, was_grounded, landing_velocity, &[], configuration);
    }
}

/// RNGFix `DoInclineCollisionFixes` (downhill part) for a landing at the end of the move (`MovementFixes::
/// rngfix_incline` with `downhill`). Like `fix_downhill_landing`, but as the plugin computes it: nothing if the move
/// hit anything ("a collision was predicted this tick, no fix is needed"), the deflection is computed from the
/// velocity including the move's base velocity (a trigger_push / conveyor on the slope) and the base velocity is
/// taken out again afterwards (`SetVelocity`; the old slopefix baked it in, a double boost), and its `ClipVelocity`
/// has no CS:S push-out.
fn fix_downhill_landing_rngfix(
    state: &mut State,
    was_grounded: bool,
    landing_velocity: [f32; 3],
    base_velocity: [f32; 3],
    move_collided: bool,
    configuration: Configuration,
) {
    if configuration.fixes.downhill
        && !was_grounded
        && !move_collided
        && landing_velocity[2] <= 0.0
        && state.water_level <= 1
        && let Some(ground) = state.ground
        && ground.normal[2] < 1.0
    {
        let velocity = add(landing_velocity, base_velocity);
        let clipped = rngfix_clip_velocity(velocity, ground.normal);
        let speed = |v: [f32; 3]| v[0] * v[0] + v[1] * v[1];
        // Landing downhill (or across: normal xy . velocity xy >= 0) always takes the clip; landing uphill only when it
        // is faster (steep inclines), the rest is the uphill fix's job.
        let uphill = ground.normal[0] * velocity[0] + ground.normal[1] * velocity[1] < 0.0;
        if !uphill || speed(clipped) > speed(velocity) {
            state.velocity[0] = clipped[0] - base_velocity[0];
            state.velocity[1] = clipped[1] - base_velocity[1];
        }
    }
}

/// RNGFix's `ClipVelocity`: `velocity - normal * (velocity . normal)`, without the engine's overbounce adjust ("only
/// matters with overbounce which doesn't apply to walkable surfaces").
fn rngfix_clip_velocity(velocity: [f32; 3], normal: [f32; 3]) -> [f32; 3] {
    let backoff = dot(velocity, normal);
    sub(velocity, scale(normal, backoff))
}

/// RNGFix `RunPreTickChecks` from the trace on: the first hull trace of this tick's airborne move (from `position`
/// along `velocity * tick`, velocity including base velocity) decides whether the player would collide with walkable
/// ground in a way that keeps them from landing or loses speed, and if so returns the start the plugin moves the
/// player to (`PreventCollision`: `collision point - velocity * tick`, 0.1 up) and which fix it was. The plugin
/// predicts this velocity before ProcessMovement; here it is the move's real one (identical except for the plugin's
/// own prediction errors, e.g. it traces a duck-transition tick from the unducked origin).
fn rngfix_prevent_collision(
    context: &mut QueryContext<'_, impl Tracer>,
    position: [f32; 3],
    velocity: [f32; 3],
    hull: Hull,
    configuration: Configuration,
    policy: Policy,
    tick: f32,
) -> Result<Option<([f32; 3], PreventedCollision)>, Error> {
    let velocity_tick = scale(velocity, tick);
    let trace = context.trace(
        QueryPurpose::Displacement,
        position,
        add(position, velocity_tick),
        hull,
        configuration.solid_mask,
    )?;
    if trace.fraction >= 1.0 || trace.start_solid || trace.all_solid {
        return Ok(None);
    }
    let Some(normal) = trace.normal else { return Ok(None) };
    let collision_point = trace.end;
    // "If we are moving up too fast, we can't land anyway so these fixes aren't needed." (NON_JUMP_VELOCITY)
    if velocity[2] > policy.ground_detach_speed {
        return Ok(None);
    }
    // "Landing also requires a walkable surface." (MIN_STANDABLE_ZNRM)
    if normal[2] < configuration.standable_normal {
        return Ok(None);
    }
    // "PreventCollision": rewind part of a tick so the move ends 0.1 above the contact without touching it. The rewound
    // start retraces this tick's path, so it is free unless something moved into it; then (a deviation: the plugin
    // doesn't check) the fix is skipped rather than starting the move stuck.
    let start = sub(collision_point, velocity_tick);
    let start = [start[0], start[1], start[2] + 0.1];
    let free = context.trace(QueryPurpose::Endpoint, start, start, hull, configuration.solid_mask)?;
    let prevent = |fix| (!free.start_solid && !free.all_solid).then_some((start, fix));
    let speed = |v: [f32; 3]| v[0] * v[0] + v[1] * v[1];
    // Uphill first ("more common and faster"): not flat, and moving into the incline.
    if configuration.fixes.rngfix_incline
        && normal[2] < 1.0
        && normal[0] * velocity[0] + normal[1] * velocity[1] < 0.0
    {
        // Unless colliding is faster (steep inclines can be): then the downhill fix's outcome is the better one.
        let downhill_instead =
            configuration.fixes.downhill && speed(rngfix_clip_velocity(velocity, normal)) > speed(velocity);
        if !downhill_instead {
            // "This naturally prevents any edge bugs so we can skip the edge fix."
            return Ok(prevent(PreventedCollision::Uphill));
        }
    }
    if !configuration.fixes.rngfix_edge {
        return Ok(None);
    }
    // Where the rest of the tick would end after the collision (assuming no further collisions).
    let fraction_left = 1.0 - trace.fraction;
    let tick_end = if normal[2] == 1.0 {
        // Level ground: only the z velocity goes.
        [
            collision_point[0] + velocity_tick[0] * fraction_left,
            collision_point[1] + velocity_tick[1] * fraction_left,
            collision_point[2],
        ]
    } else {
        let clipped = rngfix_clip_velocity(velocity, normal);
        if clipped[2] > policy.ground_detach_speed {
            // An edge bug every time: the clip leaves too much z velocity to land.
            return Ok(None);
        }
        add(collision_point, scale(clipped, tick * fraction_left))
    };
    // Is there ground to land on within LAND_HEIGHT below the end of the tick?
    let below = [tick_end[0], tick_end[1], tick_end[2] - configuration.ground_probe];
    let ground = context.trace(QueryPurpose::GroundFull, tick_end, below, hull, configuration.solid_mask)?;
    if ground.fraction < 1.0 || ground.start_solid || ground.all_solid {
        if ground.normal.is_some_and(|n| n[2] >= configuration.standable_normal) {
            return Ok(None);
        }
        // TracePlayerBBoxForGround's quadrants.
        for quadrant in quadrants(hull) {
            let trace = context.trace(QueryPurpose::GroundQuadrant, tick_end, below, quadrant, configuration.solid_mask)?;
            if (trace.fraction < 1.0 || trace.start_solid || trace.all_solid)
                && trace.normal.is_some_and(|n| n[2] >= configuration.standable_normal)
            {
                return Ok(None);
            }
        }
    }
    Ok(prevent(PreventedCollision::Edge))
}

fn start_gravity(state: &mut State, configuration: Configuration, tick: f32) {
    state.velocity[2] -= configuration.gravity * configuration.gravity_scale * tick * 0.5;
    state.velocity[2] += state.base_velocity[2] * tick;
    state.base_velocity[2] = 0.0;
    clamp_velocity(&mut state.velocity, configuration.maximum_velocity);
}

fn finish_gravity(state: &mut State, configuration: Configuration, tick: f32) {
    if state.water_jump_time_ms != 0.0 {
        return;
    }
    state.velocity[2] -= configuration.gravity * configuration.gravity_scale * tick * 0.5;
    clamp_velocity(&mut state.velocity, configuration.maximum_velocity);
}

fn add_gravity(state: &mut State, configuration: Configuration, tick: f32) {
    if state.water_jump_time_ms != 0.0 {
        return;
    }
    state.velocity[2] -= configuration.gravity * configuration.gravity_scale * tick;
    state.velocity[2] += state.base_velocity[2] * tick;
    state.base_velocity[2] = 0.0;
    clamp_velocity(&mut state.velocity, configuration.maximum_velocity);
}

fn check_jump(
    context: &QueryContext<'_, impl Tracer>,
    result: &mut StepResult,
    input: StepInput,
    command: PreparedCommand,
    configuration: Configuration,
    policy: Policy,
    tick: f32,
) -> Result<(), Error> {
    if !input.command.jump {
        result.state.jump_latched = false;
        return Ok(());
    }
    if result.state.water_jump_time_ms != 0.0 {
        return Ok(());
    }
    if result.state.water_level >= 2 {
        set_ground(
            context,
            &mut result.state,
            None,
            &mut result.contacts,
            &mut result.events,
        )?;
        if result.state.water_type == CONTENTS_WATER {
            result.state.velocity[2] = configuration.water_swim_speed;
        } else if result.state.water_type == CONTENTS_SLIME {
            result.state.velocity[2] = configuration.slime_swim_speed;
        }
        return Ok(());
    }
    if result.state.ground.is_none() {
        if !result.state.jump_latched
            && policy.allow_jump
            && result.state.crouch.phase != CrouchPhase::Unducking
            && let Some(impulse) = policy.air_dash_impulse
        {
            let forward = normalized([command.forward[0], command.forward[1], 0.0]);
            let right = normalized([command.right[0], command.right[1], 0.0]);
            let previous_z = result.state.velocity[2];
            result.state.velocity = [
                forward[0] * command.forward_move + right[0] * command.side_move,
                forward[1] * command.forward_move + right[1] * command.side_move,
                impulse,
            ];
            result.jump_velocity[2] += impulse - previous_z;
            result.events.push(Event::Jumped);
        }
        result.state.jump_latched = true;
        return Ok(());
    }
    if result.state.jump_latched
        || !policy.allow_jump
        || (!policy.allow_crouched_jump && result.state.crouch.uses_crouched_hull())
        || (result.state.crouch.phase == CrouchPhase::Unducking && !policy.jump_while_unducking)
    {
        return Ok(());
    }
    if let Some(cap) = policy.bunnyhop_speed_cap {
        cap_vector_speed(&mut result.state.velocity, cap);
    }
    // bunnyhop patch: the ground surface's jump factor (SDK flGroundFactor).
    let ground_factor = result
        .state
        .ground
        .map(|ground| ground.jump_factor)
        .unwrap_or(policy.surface_jump_factor);
    set_ground(
        context,
        &mut result.state,
        None,
        &mut result.contacts,
        &mut result.events,
    )?;
    let starting_z = result.state.velocity[2];
    let impulse = policy.jump_impulse * ground_factor;
    // bunnyhop patch: SDK 2013 replaces (rather than adds to) vertical velocity when
    // `m_bDucking || FL_DUCKING`, i.e. while ducking *or* fully ducked, not only mid-transition.
    // m_bDucking is set during the unduck transition as well (tools/parity: a duck tap released on the jump tick
    // replaces vz in the real engine). Unducking only gets here with `jump_while_unducking`.
    if policy.replace_vertical_while_ducking
        && (matches!(result.state.crouch.phase, CrouchPhase::Ducking | CrouchPhase::Unducking)
            || result.state.crouch.uses_crouched_hull())
    {
        result.state.velocity[2] = impulse;
    } else {
        result.state.velocity[2] += impulse;
    }
    if configuration.css_stamina {
        result.state.velocity[2] *= (100.0 - (result.state.stamina_ms / 1000.0 * 19.0)) / 100.0;
        result.state.stamina_ms = (25.0 / 19.0) * 1000.0;
    }
    finish_gravity(&mut result.state, configuration, tick);
    result.jump_velocity[2] += result.state.velocity[2] - starting_z;
    result.climbed_step += 0.15;
    result.state.jump_latched = true;
    result.events.push(Event::Jumped);
    Ok(())
}

fn water_jump(state: &mut State, configuration: Configuration, policy: Policy, tick: f32) {
    state.water_jump_time_ms = state
        .water_jump_time_ms
        .min(configuration.water_exit_maximum_ms);
    if state.water_jump_time_ms == 0.0 {
        return;
    }
    state.water_jump_time_ms -= 1_000.0 * tick;
    if state.water_jump_time_ms <= 0.0 || state.water_level == 0 {
        state.water_jump_time_ms = 0.0;
        // bunnyhop patch: SDK WaterJump never clears m_vecWaterJumpVel (`keep_water_jump_velocity`).
        if !policy.water.keep_water_jump_velocity {
            state.water_jump_velocity = [0.0; 3];
        }
    }
    state.velocity[0] = state.water_jump_velocity[0];
    state.velocity[1] = state.water_jump_velocity[1];
}

fn check_water_exit(
    context: &mut QueryContext<'_, impl Tracer>,
    result: &mut StepResult,
    input: StepInput,
    command: PreparedCommand,
    configuration: Configuration,
    policy: Policy,
) -> Result<(), Error> {
    if result.state.water_jump_time_ms != 0.0 || result.state.velocity[2] < -180.0 {
        return Ok(());
    }
    let mut flat_velocity = [result.state.velocity[0], result.state.velocity[1], 0.0];
    let current_speed = normalize_in_place(&mut flat_velocity);
    let mut flat_forward = if policy.water.ledge_uses_command_direction {
        [
            command.forward[0] * command.forward_move + command.right[0] * command.side_move,
            command.forward[1] * command.forward_move + command.right[1] * command.side_move,
            0.0,
        ]
    } else {
        [command.forward[0], command.forward[1], 0.0]
    };
    normalize_in_place(&mut flat_forward);
    if current_speed != 0.0
        && dot(flat_velocity, flat_forward) < 0.0
        && !(policy.water.ledge_jump_overrides_backward && input.command.jump)
    {
        return Ok(());
    }

    let hull = result.state.active_hull(policy);
    let waist_start = add(result.state.position, scale(add(hull.mins, hull.maxs), 0.5));
    let waist_end = add(
        waist_start,
        scale(flat_forward, configuration.water_exit_forward),
    );
    let waist = context.trace(
        QueryPurpose::WaterWaist,
        waist_start,
        waist_end,
        hull,
        configuration.solid_mask,
    )?;
    if waist.fraction >= 1.0 {
        return Ok(());
    }
    // bunnyhop patch: a start-solid waist trace has no plane; SDK 2013 then uses the zero
    // plane normal (no push), the port used to fail the whole step.
    let waist_normal = waist.normal.unwrap_or([0.0; 3]);
    let eye_start = [
        waist_start[0],
        waist_start[1],
        result.state.position[2] + result.state.view_offset[2] + configuration.water_exit_height,
    ];
    let eye_end = add(
        eye_start,
        scale(flat_forward, configuration.water_exit_forward),
    );
    let eye = context.trace(
        QueryPurpose::WaterEye,
        eye_start,
        eye_end,
        hull,
        configuration.solid_mask,
    )?;
    if eye.fraction != 1.0 || eye.start_solid || eye.all_solid {
        return Ok(());
    }
    let landing_end = [
        eye_end[0],
        eye_end[1],
        eye_end[2] - configuration.water_exit_down,
    ];
    let landing = context.trace(
        QueryPurpose::WaterLanding,
        eye_end,
        landing_end,
        hull,
        configuration.solid_mask,
    )?;
    if !standable(landing, configuration.standable_normal) {
        return Ok(());
    }
    result.state.water_jump_velocity = scale(waist_normal, -configuration.water_exit_push_speed);
    result.state.velocity[2] = configuration.water_exit_up_speed;
    result.state.water_jump_time_ms = configuration.water_exit_duration_ms;
    result.state.jump_latched = true;
    set_ground(
        context,
        &mut result.state,
        None,
        &mut result.contacts,
        &mut result.events,
    )
}

fn water_move(
    context: &mut QueryContext<'_, impl Tracer>,
    result: &mut StepResult,
    input: StepInput,
    command: PreparedCommand,
    configuration: Configuration,
    policy: Policy,
    tick: f32,
) -> Result<(), Error> {
    let mut wish_velocity = add(
        scale(command.forward, command.forward_move),
        scale(command.right, command.side_move),
    );
    let client_max_speed = if configuration.client_max_speed != 0.0 {
        configuration.client_max_speed
    } else {
        policy.maximum_speed
    };
    if input.command.jump {
        if policy.water.jump_wish_at_waist || result.state.water_level >= 3 {
            wish_velocity[2] += client_max_speed;
        }
    } else if command.forward_move == 0.0 && command.side_move == 0.0 && command.up_move == 0.0 {
        wish_velocity[2] -= configuration.water_idle_sink_speed;
    } else {
        let pitched_up = if policy.water.amplify_forward_pitch {
            (command.forward_move * command.forward[2] * 2.0).clamp(0.0, client_max_speed)
        } else {
            0.0
        };
        wish_velocity[2] += command.up_move + pitched_up;
    }
    let uncapped = length(wish_velocity);
    let direction = normalized(wish_velocity);
    let clamped = uncapped.min(command.maximum_speed);
    if uncapped > command.maximum_speed && uncapped > 0.0 {
        wish_velocity = scale(wish_velocity, command.maximum_speed / uncapped);
    }
    let wish_speed = clamped * configuration.water_wish_speed_factor;
    result.wish_state = WishState {
        direction,
        speed: wish_speed,
        uncapped_speed: uncapped,
    };

    let speed = length(result.state.velocity);
    let new_speed = if speed != 0.0 {
        let next =
            speed - tick * speed * configuration.friction * surface_friction(result.state, policy);
        let next = if next < 0.1 { 0.0 } else { next };
        result.state.velocity = scale(result.state.velocity, next / speed);
        next
    } else {
        0.0
    };
    if wish_speed >= 0.1 {
        let add_speed = wish_speed - new_speed;
        if add_speed > 0.0 {
            let acceleration = (configuration.acceleration
                * wish_speed
                * tick
                * surface_friction(result.state, policy))
            .min(add_speed);
            let delta = scale(normalized(wish_velocity), acceleration);
            result.state.velocity = add(result.state.velocity, delta);
            result.wish_velocity = add(result.wish_velocity, delta);
        }
    }

    let hull = result.state.active_hull(policy);
    let total_velocity = add(result.state.velocity, result.state.base_velocity);
    let destination = add(result.state.position, scale(total_velocity, tick));
    let direct = context.trace(
        QueryPurpose::Displacement,
        result.state.position,
        destination,
        hull,
        configuration.solid_mask,
    )?;
    let movement = if direct.fraction == 1.0 {
        let mut elevated = destination;
        if configuration.allow_auto_movement {
            elevated[2] += configuration.step_height + 1.0;
        }
        let down = context.trace(
            QueryPurpose::StepDown,
            elevated,
            destination,
            hull,
            configuration.solid_mask,
        )?;
        if !down.start_solid && !down.all_solid {
            MoveOutcome {
                path: context.observe.then(|| AcceptedPath::unsupported("unsupported-branch")),
                position: down.end,
                velocity: total_velocity,
                contacts: Vec::new(),
                climbed: down.end[2] - result.state.position[2],
                trapped: false,
            }
        } else {
            slide(
                context,
                result.state.position,
                total_velocity,
                hull,
                configuration,
                tick,
                false,
                result.state.ground.is_none(),
                QueryPurpose::Displacement,
                surface_friction(result.state, policy),
            )?
        }
    } else if result.state.ground.is_none() {
        slide(
            context,
            result.state.position,
            total_velocity,
            hull,
            configuration,
            tick,
            false,
            true,
            QueryPurpose::Displacement,
            surface_friction(result.state, policy),
        )?
    } else {
        step_move(
            context,
            result.state.position,
            total_velocity,
            hull,
            configuration,
            policy.step_strategy,
            tick,
            surface_friction(result.state, policy),
        )?
    };
    apply_move_outcome(result, movement);
    result.state.velocity = sub(result.state.velocity, result.state.base_velocity);
    Ok(())
}

fn check_water(
    context: &mut QueryContext<'_, impl Tracer>,
    state: &mut State,
    configuration: Configuration,
    policy: Policy,
) -> Result<bool, Error> {
    let hull = state.active_hull(policy);
    let center_x = state.position[0] + (hull.mins[0] + hull.maxs[0]) * 0.5;
    let center_y = state.position[1] + (hull.mins[1] + hull.maxs[1]) * 0.5;
    let feet = [center_x, center_y, state.position[2] + hull.mins[2] + 1.0];
    state.water_level = 0;
    state.water_type = 0;
    let mut contents = context.point(PointQueryPurpose::WaterFeet, feet)?;
    if contents & configuration.water_mask == 0 {
        return Ok(false);
    }

    state.water_type = contents & (CONTENTS_WATER | CONTENTS_SLIME);
    state.water_level = 1;
    let waist = [
        center_x,
        center_y,
        state.position[2] + (hull.mins[2] + hull.maxs[2]) * 0.5 + policy.water.waist_height_offset,
    ];
    let eyes = [center_x, center_y, state.position[2] + state.view_offset[2]];

    match policy.water.sampling {
        WaterSampling::WaistThenEyes => {
            contents = context.point(PointQueryPurpose::WaterWaist, waist)?;
            if contents & configuration.water_mask != 0 {
                state.water_level = 2;
                contents = context.point(PointQueryPurpose::WaterEyes, eyes)?;
                if contents & configuration.water_mask != 0 {
                    state.water_level = 3;
                }
            }
        }
        WaterSampling::EyesThenWaist => {
            contents = context.point(PointQueryPurpose::WaterEyes, eyes)?;
            if contents & configuration.water_mask != 0 {
                state.water_level = 3;
            } else {
                contents = context.point(PointQueryPurpose::WaterWaist, waist)?;
                if contents & configuration.water_mask != 0 {
                    state.water_level = 2;
                }
            }
        }
    }

    if policy.water.apply_currents && contents & MASK_CURRENT != 0 {
        let mut current = [0.0; 3];
        if contents & CONTENTS_CURRENT_0 != 0 {
            current[0] += 1.0;
        }
        if contents & CONTENTS_CURRENT_90 != 0 {
            current[1] += 1.0;
        }
        if contents & CONTENTS_CURRENT_180 != 0 {
            current[0] -= 1.0;
        }
        if contents & CONTENTS_CURRENT_270 != 0 {
            current[1] -= 1.0;
        }
        if contents & CONTENTS_CURRENT_UP != 0 {
            current[2] += 1.0;
        }
        if contents & CONTENTS_CURRENT_DOWN != 0 {
            current[2] -= 1.0;
        }
        state.base_velocity = add(
            state.base_velocity,
            scale(
                current,
                configuration.current_speed_per_level * f32::from(state.water_level),
            ),
        );
    }
    Ok(state.water_level > 1)
}

fn clear_water(state: &mut State) {
    state.water_level = 0;
    state.water_type = 0;
    state.water_jump_time_ms = 0.0;
    state.water_jump_velocity = [0.0; 3];
}

fn categorize_position(
    context: &mut QueryContext<'_, impl Tracer>,
    state: &mut State,
    configuration: Configuration,
    policy: Policy,
    contacts: &mut Vec<Contact>,
    events: &mut Vec<Event>,
    detached_by_upward_speed: &mut bool,
) -> Result<(), Error> {
    state.surface_friction = 1.0;
    check_water(context, state, configuration, policy)?;
    if state.mode == Mode::Observer {
        return Ok(());
    }
    if state.mode == Mode::Ladder && state.velocity[2] > 0.0 {
        return set_ground(context, state, None, contacts, events);
    }
    let support_velocity_z = if policy.ground_detach_relative_to_support && let Some(support) = state.ground.and_then(|ground| ground.support) {
        context.tracer.support_velocity(support)?[2]
    } else {
        0.0
    };
    if state.velocity[2] - support_velocity_z > policy.ground_detach_speed {
        *detached_by_upward_speed = true;
        return set_ground(context, state, None, contacts, events);
    }

    let was_grounded = state.ground.is_some();
    let mut distance = configuration.ground_probe;
    let move_to_end = policy.step_strategy == StepStrategy::HighFirst
        && state.mode == Mode::Walk
        && was_grounded
        && state.water_level < 3;
    if move_to_end {
        distance += configuration.step_height;
    }
    let end = [
        state.position[0],
        state.position[1],
        state.position[2] - distance,
    ];
    let hull = state.active_hull(policy);
    let full = context.trace(
        QueryPurpose::GroundFull,
        state.position,
        end,
        hull,
        configuration.solid_mask,
    )?;
    let mut support_trace = standable(full, configuration.standable_normal).then_some(full);
    if support_trace.is_none() {
        for quadrant in quadrants(hull) {
            let trace = context.trace(
                QueryPurpose::GroundQuadrant,
                state.position,
                end,
                quadrant,
                configuration.solid_mask,
            )?;
            if standable(trace, configuration.standable_normal) {
                support_trace = Some(Trace {
                    fraction: full.fraction,
                    end: full.end,
                    ..trace
                });
                break;
            }
        }
    }
    let Some(trace) = support_trace else {
        if state.velocity[2] > 0.0 && state.mode != Mode::Noclip {
            state.surface_friction = 0.25;
        }
        return set_ground(context, state, None, contacts, events);
    };
    if move_to_end
        && !trace.start_solid
        && trace.fraction > 0.0
        && trace.fraction < 1.0
        && (state.position[2] - trace.end[2]).abs() > configuration.ground_network_snap
    {
        state.position[2] = trace.end[2];
    }
    // bunnyhop patch: per-surface friction / jump factor (SDK CategorizeGroundSurface:
    // m_surfaceFriction = min(surfaceprop friction * 1.25, 1)).
    let surface = context.tracer.ground_surface(&trace);
    let friction = surface
        .map(|s| (s.friction * 1.25).min(1.0))
        .unwrap_or(policy.surface_friction);
    let ground = GroundState {
        support: trace.hit,
        normal: trace.normal.expect("standable traces have planes"),
        surface_friction: friction,
        jump_factor: surface.map(|s| s.jump_factor).unwrap_or(policy.surface_jump_factor),
    };
    state.surface_friction = friction;
    set_ground(context, state, Some(ground), contacts, events)
}

fn set_ground(
    context: &QueryContext<'_, impl Tracer>,
    state: &mut State,
    ground: Option<GroundState>,
    _contacts: &mut Vec<Contact>,
    events: &mut Vec<Event>,
) -> Result<(), Error> {
    let old_support = state.ground.and_then(|value| value.support);
    let new_support = ground.and_then(|value| value.support);
    if state.ground.is_none() && ground.is_some() {
        let support_velocity = if let Some(support) = new_support {
            context.tracer.support_velocity(support)?
        } else {
            [0.0; 3]
        };
        state.base_velocity = sub(state.base_velocity, support_velocity);
        state.base_velocity[2] = support_velocity[2];
    } else if state.ground.is_some() && ground.is_none() {
        let support_velocity = if let Some(support) = old_support {
            context.tracer.support_velocity(support)?
        } else {
            [0.0; 3]
        };
        state.base_velocity = add(state.base_velocity, support_velocity);
        state.base_velocity[2] = support_velocity[2];
    }
    let changed = state.ground.is_some() != ground.is_some() || old_support != new_support;
    state.ground = ground;
    if ground.is_some() {
        state.water_jump_time_ms = 0.0;
        state.velocity[2] = 0.0;
    }
    if changed {
        events.push(Event::GroundChanged {
            from: old_support,
            to: new_support,
        });
    }
    Ok(())
}

fn land(
    context: &QueryContext<'_, impl Tracer>,
    result: &mut StepResult,
    configuration: Configuration,
) -> Result<(), Error> {
    let mut speed = result.state.fall_speed;
    if result.state.water_level == 0
        && speed >= configuration.fall_punch_threshold
        && let Some(support) = result.state.ground.and_then(|ground| ground.support)
    {
        if context.tracer.support_is_floating(support)? {
            speed -= configuration.floating_fall_reduction;
        }
        let support_z = context.tracer.support_velocity(support)?[2];
        if support_z < 0.0 {
            speed = (speed + support_z).max(0.1);
        }
    }
    result.events.push(Event::Landed { fall_speed: speed });
    result.state.fall_speed = 0.0;
    Ok(())
}

fn horizontal_wish(command: PreparedCommand) -> WishState {
    let forward = normalized([command.forward[0], command.forward[1], 0.0]);
    let right = normalized([command.right[0], command.right[1], 0.0]);
    let wish_velocity = add(
        scale(forward, command.forward_move),
        scale(right, command.side_move),
    );
    let uncapped = length(wish_velocity);
    WishState {
        direction: normalized(wish_velocity),
        speed: uncapped.min(command.maximum_speed),
        uncapped_speed: uncapped,
    }
}

fn ground_friction(
    velocity: &mut [f32; 3],
    configuration: Configuration,
    surface_friction: f32,
    water_jump_time_ms: f32,
    tick: f32,
) -> [f32; 3] {
    if water_jump_time_ms != 0.0 {
        return [0.0; 3];
    }
    let speed = length(*velocity);
    if speed < 0.1 {
        return [0.0; 3];
    }
    let control = speed.max(configuration.stop_speed);
    let drop = control * configuration.friction * surface_friction * tick;
    let ratio = (speed - drop).max(0.0) / speed;
    *velocity = scale(*velocity, ratio);
    scale(*velocity, -(1.0 - ratio))
}

fn accelerate(
    velocity: &mut [f32; 3],
    direction: [f32; 3],
    wish_speed: f32,
    acceleration: f32,
    tick: f32,
    surface_friction: f32,
) -> [f32; 3] {
    let add_speed = wish_speed - dot(*velocity, direction);
    if wish_speed == 0.0 || add_speed <= 0.0 {
        return [0.0; 3];
    }
    let acceleration_speed = (acceleration * tick * wish_speed * surface_friction).min(add_speed);
    let delta = scale(direction, acceleration_speed);
    *velocity = add(*velocity, delta);
    delta
}

fn air_accelerate(
    velocity: &mut [f32; 3],
    direction: [f32; 3],
    uncapped_wish_speed: f32,
    acceleration: f32,
    air_cap: f32,
    tick: f32,
    surface_friction: f32,
) -> [f32; 3] {
    let capped = uncapped_wish_speed.min(air_cap);
    let add_speed = capped - dot(*velocity, direction);
    if uncapped_wish_speed == 0.0 || add_speed <= 0.0 {
        return [0.0; 3];
    }
    let acceleration_speed =
        (acceleration * tick * uncapped_wish_speed * surface_friction).min(add_speed);
    let delta = scale(direction, acceleration_speed);
    *velocity = add(*velocity, delta);
    delta
}

fn surface_friction(state: State, policy: Policy) -> f32 {
    if state.surface_friction.is_finite() {
        state.surface_friction
    } else {
        policy.surface_friction
    }
}

fn clamp_backward_speed(
    velocity: &mut [f32; 3],
    forward: [f32; 3],
    right: [f32; 3],
    maximum_speed: f32,
    policy: Policy,
) {
    if policy.backward_speed_factor >= 1.0 || length(*velocity) <= policy.backward_speed_minimum {
        return;
    }
    let forward_speed = dot(*velocity, forward);
    if forward_speed >= 0.0 {
        return;
    }
    let mut backward = scale(forward, forward_speed);
    let lateral = scale(right, dot(*velocity, right));
    let speed = length(backward);
    let maximum_backward = maximum_speed * policy.backward_speed_factor;
    if speed > maximum_backward {
        backward = scale(backward, maximum_backward / speed);
    }
    let z = velocity[2];
    *velocity = add(backward, lateral);
    velocity[2] = z;
    cap_horizontal_speed(velocity, maximum_speed);
}

#[derive(Clone, Debug)]
struct MoveOutcome {
    path: Option<AcceptedPath>,
    position: [f32; 3],
    velocity: [f32; 3],
    contacts: Vec<Contact>,
    climbed: f32,
    trapped: bool,
}

fn apply_move_outcome(result: &mut StepResult, movement: MoveOutcome) {
    result.accepted_path = movement.path;
    result.state.position = movement.position;
    result.state.velocity = movement.velocity;
    result.contacts.extend(movement.contacts);
    if movement.trapped {
        result.state.velocity = [0.0; 3];
        result.events.push(Event::Trapped);
    }
    if movement.climbed > 0.0 {
        result.climbed_step += movement.climbed;
        result.events.push(Event::Stepped {
            height: movement.climbed,
        });
    }
}

#[allow(clippy::too_many_arguments)]
fn walk_move(
    context: &mut QueryContext<'_, impl Tracer>,
    start: [f32; 3],
    velocity: [f32; 3],
    hull: Hull,
    configuration: Configuration,
    strategy: StepStrategy,
    tick: f32,
    surface_friction: f32,
) -> Result<MoveOutcome, Error> {
    if length(velocity) < 1.0 {
        return Ok(MoveOutcome {
            path: context.observe.then(|| AcceptedPath::motion(start, start, hull)),
            position: start,
            velocity: [0.0; 3],
            contacts: Vec::new(),
            climbed: 0.0,
            trapped: false,
        });
    }
    let destination = [
        start[0] + velocity[0] * tick,
        start[1] + velocity[1] * tick,
        start[2],
    ];
    let direct = context.trace(
        QueryPurpose::Displacement,
        start,
        destination,
        hull,
        configuration.solid_mask,
    )?;
    if direct.all_solid {
        return Ok(MoveOutcome {
            path: context.observe.then(|| AcceptedPath::unsupported("unsupported-branch")),
            position: start,
            velocity: [0.0; 3],
            contacts: Vec::new(),
            climbed: 0.0,
            trapped: true,
        });
    }
    if direct.fraction == 1.0 {
        let endpoint = context.trace(
            QueryPurpose::Endpoint,
            direct.end,
            direct.end,
            hull,
            configuration.solid_mask,
        )?;
        if endpoint.start_solid || endpoint.fraction != 1.0 {
            return Ok(MoveOutcome {
                path: context.observe.then(|| AcceptedPath::unsupported("unsupported-branch")),
                position: start,
                velocity: [0.0; 3],
                contacts: Vec::new(),
                climbed: 0.0,
                trapped: true,
            });
        }
        let grounded = stay_on_ground(context, direct.end, hull, configuration)?;
        return Ok(MoveOutcome {
            path: context.observe.then(|| {
                let mut p = AcceptedPath::motion(start, direct.end, hull);
                if grounded != direct.end { p.phase_change(direct.end, grounded, hull, 1.0, false); }
                p
            }),
            position: grounded,
            velocity,
            contacts: Vec::new(),
            climbed: 0.0,
            trapped: false,
        });
    }
    let mut outcome = step_move(
        context,
        start,
        velocity,
        hull,
        configuration,
        strategy,
        tick,
        surface_friction,
    )?;
    let before_snap = outcome.position;
    outcome.position = stay_on_ground(context, outcome.position, hull, configuration)?;
    if before_snap != outcome.position {
        if let Some(p) = &mut outcome.path { p.phase_change(before_snap, outcome.position, hull, 1.0, false); }
    }
    Ok(outcome)
}

fn stay_on_ground(
    context: &mut QueryContext<'_, impl Tracer>,
    position: [f32; 3],
    hull: Hull,
    configuration: Configuration,
) -> Result<[f32; 3], Error> {
    let up_end = [
        position[0],
        position[1],
        position[2] + configuration.stay_ground_rise,
    ];
    let up = context.trace(
        QueryPurpose::StayGroundUp,
        position,
        up_end,
        hull,
        configuration.solid_mask,
    )?;
    let down_end = [
        position[0],
        position[1],
        position[2] - configuration.step_height,
    ];
    let down = context.trace(
        QueryPurpose::StayGroundDown,
        up.end,
        down_end,
        hull,
        configuration.solid_mask,
    )?;
    if down.fraction > 0.0
        && down.fraction < 1.0
        && !down.start_solid
        && down
            .normal
            .is_some_and(|normal| normal[2] >= configuration.standable_normal)
        && (position[2] - down.end[2]).abs() > configuration.ground_network_snap
    {
        Ok(down.end)
    } else {
        Ok(position)
    }
}

#[allow(clippy::too_many_arguments)]
fn step_move(
    context: &mut QueryContext<'_, impl Tracer>,
    start: [f32; 3],
    velocity: [f32; 3],
    hull: Hull,
    configuration: Configuration,
    strategy: StepStrategy,
    tick: f32,
    surface_friction: f32,
) -> Result<MoveOutcome, Error> {
    match strategy {
        StepStrategy::FurthestHorizontal => {
            let low = slide(
                context,
                start,
                velocity,
                hull,
                configuration,
                tick,
                true,
                false,
                QueryPurpose::Displacement,
                surface_friction,
            )?;
            let Some(mut high) = high_step(
                context,
                start,
                velocity,
                hull,
                configuration,
                tick,
                surface_friction,
                true,
            )?
            else {
                return Ok(low);
            };
            if horizontal_distance_squared(start, high.position)
                >= horizontal_distance_squared(start, low.position)
            {
                high.velocity[2] = low.velocity[2];
                Ok(high)
            } else {
                Ok(low)
            }
        }
        StepStrategy::HighFirst => {
            if let Some(high) = high_step(
                context,
                start,
                velocity,
                hull,
                configuration,
                tick,
                surface_friction,
                false,
            )? {
                return Ok(high);
            }
            slide(
                context,
                start,
                velocity,
                hull,
                configuration,
                tick,
                true,
                false,
                QueryPurpose::Displacement,
                surface_friction,
            )
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn high_step(
    context: &mut QueryContext<'_, impl Tracer>,
    start: [f32; 3],
    velocity: [f32; 3],
    hull: Hull,
    configuration: Configuration,
    tick: f32,
    surface_friction: f32,
    require_standable: bool,
) -> Result<Option<MoveOutcome>, Error> {
    if !configuration.allow_auto_movement {
        return Ok(None);
    }
    let distance = configuration.step_height + configuration.step_epsilon;
    let up_end = [start[0], start[1], start[2] + distance];
    let up = context.trace(
        QueryPurpose::StepUp,
        start,
        up_end,
        hull,
        configuration.solid_mask,
    )?;
    if up.start_solid || up.all_solid {
        return Ok(None);
    }
    let mut moved = slide(
        context,
        up.end,
        velocity,
        hull,
        configuration,
        tick,
        true,
        false,
        QueryPurpose::Displacement,
        surface_friction,
    )?;
    if moved.trapped || moved.position == start {
        return Ok(None);
    }
    let down_end = [
        moved.position[0],
        moved.position[1],
        moved.position[2] - distance,
    ];
    let down = context.trace(
        QueryPurpose::StepDown,
        moved.position,
        down_end,
        hull,
        configuration.solid_mask,
    )?;
    if require_standable && !standable(down, configuration.standable_normal) {
        return Ok(None);
    }
    if !require_standable
        && down.fraction != 1.0
        && down
            .normal
            .is_some_and(|normal| normal[2] < configuration.standable_normal)
    {
        return Ok(None);
    }
    let before_down = moved.position;
    if !down.start_solid && !down.all_solid {
        moved.position = down.end;
    }
    if let Some(p) = &mut moved.path {
        p.phase_change(start, up.end, hull, 0.0, true);
        if before_down != moved.position { p.phase_change(before_down, moved.position, hull, 1.0, false); }
    }
    moved.climbed = (moved.position[2] - start[2]).max(0.0);
    Ok(Some(moved))
}

#[allow(clippy::too_many_arguments)]
fn slide(
    context: &mut QueryContext<'_, impl Tracer>,
    start: [f32; 3],
    mut velocity: [f32; 3],
    hull: Hull,
    configuration: Configuration,
    tick: f32,
    walk_mode: bool,
    airborne: bool,
    purpose: QueryPurpose,
    surface_friction: f32,
) -> Result<MoveOutcome, Error> {
    let primal_velocity = velocity;
    let mut original_velocity = velocity;
    let mut position = start;
    let mut remaining = tick;
    let mut path = context.observe.then(AcceptedPath::default);
    let mut fraction_sum = 0.0;
    let mut planes = Vec::with_capacity(MAX_CLIP_PLANES);
    let mut contacts = Vec::new();

    for bump in 0..MAX_BUMPS {
        if length(velocity) == 0.0 || remaining <= 0.0 {
            break;
        }
        let end = add(position, scale(velocity, remaining));
        let trace = context.trace(purpose, position, end, hull, configuration.solid_mask)?;
        fraction_sum += trace.fraction;
        if trace.all_solid
            && configuration.fixes.rampbug
            && airborne
            && let Some(free) = unstick(context, position, planes.last().copied(), hull, configuration)?
        {
            // bunnyhop patch (rampbug fix): pushed out of the seam; retry from there.
            if let Some(p) = &mut path { p.reject("unstick"); }
            position = free;
            continue;
        }
        if trace.all_solid {
            return Ok(MoveOutcome {
                path: context.observe.then(|| AcceptedPath::unsupported("unsupported-branch")),
                position,
                velocity: [0.0; 3],
                contacts,
                climbed: 0.0,
                trapped: true,
            });
        }
        if trace.fraction > 0.0 {
            if trace.fraction == 1.0 {
                let endpoint = context.trace(
                    QueryPurpose::Endpoint,
                    trace.end,
                    trace.end,
                    hull,
                    configuration.solid_mask,
                )?;
                if endpoint.start_solid || endpoint.fraction != 1.0 {
                    // bunnyhop patch (rampbug fix): accept the move if a tiny push along the
                    // last plane frees the end position, instead of stopping dead.
                    if configuration.fixes.rampbug
                        && airborne
                        && let Some(free) =
                            unstick(context, trace.end, planes.last().copied(), hull, configuration)?
                    {
                        if let Some(p) = &mut path { p.reject("unstick"); }
                        position = free;
                        break;
                    }
                    velocity = [0.0; 3];
                    break;
                }
            }
            if let Some(p) = &mut path {
                let t0 = 1.0 - f64::from(remaining) / f64::from(tick);
                let next_remaining = remaining - remaining * trace.fraction;
                let t1 = 1.0 - f64::from(next_remaining) / f64::from(tick);
                p.segments.push(MotionSegment { discrete: false, from: position, to: trace.end, t0, t1, hull });
            }
            position = trace.end;
            original_velocity = velocity;
            planes.clear();
        }
        if trace.fraction == 1.0 {
            break;
        }
        let Some(normal) = trace.normal else {
            velocity = [0.0; 3];
            break;
        };
        record_contact_from_parts(&mut contacts, trace.hit, normal, velocity);
        remaining -= remaining * trace.fraction;
        // bunnyhop patch (uphill fix): falling onto an uphill walkable slope lands on it with
        // the horizontal speed intact instead of clipping into it.
        if configuration.fixes.uphill
            && walk_mode
            && airborne
            && bump == 0
            && normal[2] >= configuration.standable_normal
            && normal[2] < 1.0
            && original_velocity[2] <= 140.0
            && original_velocity[0] * normal[0] + original_velocity[1] * normal[1] < 0.0
        {
            let clipped = clip_velocity(original_velocity, normal, 1.0, configuration.clip_push_out);
            let speed = |v: [f32; 3]| v[0] * v[0] + v[1] * v[1];
            if speed(clipped) <= speed(original_velocity) {
                velocity = [original_velocity[0], original_velocity[1], 0.0];
                break;
            }
        }
        // bunnyhop patch (rampbug fix): the same plane again (float error on a ramp seam):
        // nudge away from it like Quake 2's SV_FlyMove instead of treating it as a crease.
        if configuration.fixes.rampbug
            && airborne
            && planes.iter().any(|plane| dot(*plane, normal) > 0.99)
        {
            velocity = add(velocity, normal);
            continue;
        }
        if planes.len() >= MAX_CLIP_PLANES {
            velocity = [0.0; 3];
            break;
        }
        planes.push(normal);

        if planes.len() == 1 && walk_mode && airborne {
            let overbounce = if normal[2] > configuration.standable_normal {
                1.0
            } else {
                1.0 + configuration.bounce * (1.0 - surface_friction)
            };
            velocity = clip_velocity(original_velocity, normal, overbounce, configuration.clip_push_out);
            original_velocity = velocity;
            continue;
        }

        let mut accepted = None;
        let mut last_candidate = velocity;
        for (index, plane) in planes.iter().enumerate() {
            let candidate = clip_velocity(original_velocity, *plane, 1.0, configuration.clip_push_out);
            last_candidate = candidate;
            if planes
                .iter()
                .enumerate()
                .all(|(other_index, other)| other_index == index || dot(candidate, *other) >= 0.0)
            {
                accepted = Some(candidate);
                break;
            }
        }
        velocity = if let Some(candidate) = accepted {
            candidate
        } else if planes.len() == 2 {
            let direction = normalized(cross(planes[0], planes[1]));
            scale(direction, dot(direction, last_candidate))
        } else {
            [0.0; 3]
        };
        if dot(velocity, primal_velocity) <= 0.0 {
            velocity = [0.0; 3];
            break;
        }
    }
    if let Some(p) = &mut path {
        let t0 = p.segments.last().map_or(0.0, |s| s.t1);
        if t0 < 1.0 { p.segments.push(MotionSegment { discrete: false, from: position, to: position, t0, t1: 1.0, hull }); }
    }
    let ramp_stall = configuration.fixes.rampbug
        && airborne
        && planes.iter().any(|plane| plane[2] > 0.0 && plane[2] < configuration.standable_normal);
    if fraction_sum == 0.0 && !ramp_stall {
        velocity = [0.0; 3];
    }
    Ok(MoveOutcome {
        path,
        position,
        velocity,
        contacts,
        climbed: 0.0,
        trapped: false,
    })
}

/// bunnyhop patch (rampbug fix): find a free position within 1 unit of `position` along
/// `normal` (or straight up), for hulls left embedded by float error on ramp seams.
fn unstick(
    context: &mut QueryContext<'_, impl Tracer>,
    position: [f32; 3],
    normal: Option<[f32; 3]>,
    hull: Hull,
    configuration: Configuration,
) -> Result<Option<[f32; 3]>, Error> {
    let directions = [normal.unwrap_or([0.0, 0.0, 1.0]), [0.0, 0.0, 1.0]];
    for direction in directions {
        for step in [0.03125, 0.0625, 0.125, 0.25, 0.5, 1.0] {
            let candidate = add(position, scale(direction, step));
            let trace = context.trace(
                QueryPurpose::StuckRecovery,
                candidate,
                candidate,
                hull,
                configuration.solid_mask,
            )?;
            if !trace.start_solid && !trace.all_solid {
                return Ok(Some(candidate));
            }
        }
    }
    Ok(None)
}

fn noclip(
    result: &mut StepResult,
    input: StepInput,
    command: PreparedCommand,
    configuration: Configuration,
    policy: Policy,
    tick: f32,
) {
    let maximum_speed = configuration.server_max_speed * configuration.noclip_speed;
    let factor = if input.speed_button {
        configuration.noclip_speed * 0.5
    } else {
        configuration.noclip_speed
    };
    let mut wish_velocity = add(
        scale(command.forward, command.forward_move * factor),
        scale(command.right, command.side_move * factor),
    );
    wish_velocity[2] += command.up_move * factor;
    let uncapped = length(wish_velocity);
    let direction = normalized(wish_velocity);
    let speed = uncapped.min(maximum_speed);
    wish_velocity = scale(direction, speed);
    result.wish_state = WishState {
        direction,
        speed,
        uncapped_speed: uncapped,
    };
    result.wish_velocity = wish_velocity;

    let movement_surface_friction = surface_friction(result.state, policy);
    if configuration.noclip_acceleration > 0.0 {
        accelerate(
            &mut result.state.velocity,
            direction,
            speed,
            configuration.noclip_acceleration,
            tick,
            movement_surface_friction,
        );
        let current = length(result.state.velocity);
        if current < 1.0 {
            result.state.velocity = [0.0; 3];
            return;
        }
        let control = current.max(maximum_speed * 0.25);
        let drop = control * configuration.friction * movement_surface_friction * tick;
        result.state.velocity = scale(result.state.velocity, (current - drop).max(0.0) / current);
    } else {
        result.state.velocity = wish_velocity;
    }
    result.state.position = add(result.state.position, scale(result.state.velocity, tick));
    if configuration.noclip_acceleration < 0.0 {
        result.state.velocity = [0.0; 3];
    }
}

fn observer_move(
    context: &mut QueryContext<'_, impl Tracer>,
    result: &mut StepResult,
    input: StepInput,
    command: PreparedCommand,
    configuration: Configuration,
    policy: Policy,
    tick: f32,
) -> Result<(), Error> {
    match result.state.observer_mode {
        ObserverMode::InEye | ObserverMode::Chase | ObserverMode::PointOfInterest => {
            if let Some(target) = result.state.observer_target
                && let Some(target) = context.tracer.observer_target(target)?
            {
                result.state.position = target.position;
                result.state.absolute_view_angles = target.angles;
                result.state.velocity = target.velocity;
            }
            Ok(())
        }
        ObserverMode::Roaming if configuration.spectator_noclip => {
            let noclip_configuration = Configuration {
                noclip_speed: configuration.spectator_speed,
                noclip_acceleration: configuration.spectator_acceleration,
                ..configuration
            };
            noclip(result, input, command, noclip_configuration, policy, tick);
            Ok(())
        }
        ObserverMode::Roaming => {
            let factor = if input.speed_button {
                configuration.spectator_speed * 0.5
            } else {
                configuration.spectator_speed
            };
            let mut wish_velocity = add(
                scale(command.forward, command.forward_move * factor),
                scale(command.right, command.side_move * factor),
            );
            wish_velocity[2] += command.up_move;
            let uncapped = length(wish_velocity);
            let direction = normalized(wish_velocity);
            let speed = uncapped.min(configuration.maximum_velocity);
            if uncapped > configuration.maximum_velocity && uncapped > 0.0 {
                wish_velocity = scale(wish_velocity, command.maximum_speed / uncapped);
            }
            result.wish_state = WishState {
                direction,
                speed,
                uncapped_speed: uncapped,
            };
            result.wish_velocity = wish_velocity;
            let movement_surface_friction = surface_friction(result.state, policy);
            accelerate(
                &mut result.state.velocity,
                direction,
                speed,
                configuration.spectator_acceleration,
                tick,
                movement_surface_friction,
            );
            let current = length(result.state.velocity);
            if current < 1.0 {
                result.state.velocity = [0.0; 3];
                return Ok(());
            }
            let next = (current - current * configuration.friction * tick).max(0.0);
            result.state.velocity = scale(result.state.velocity, next / current);
            clamp_velocity(&mut result.state.velocity, configuration.maximum_velocity);
            let hull = configuration.observer_hull.ok_or_else(|| {
                Error::new(Operation::Validate, FailureKind::Missing, "observer-hull")
            })?;
            let movement = slide(
                context,
                result.state.position,
                result.state.velocity,
                hull,
                configuration,
                tick,
                false,
                true,
                QueryPurpose::ObserverDisplacement,
                movement_surface_friction,
            )?;
            apply_move_outcome(result, movement);
            Ok(())
        }
        ObserverMode::None
        | ObserverMode::Deathcam
        | ObserverMode::Freezecam
        | ObserverMode::Fixed => Ok(()),
    }
}

fn toss_move(
    context: &mut QueryContext<'_, impl Tracer>,
    result: &mut StepResult,
    command: PreparedCommand,
    configuration: Configuration,
    policy: Policy,
    tick: f32,
) -> Result<(), Error> {
    check_water(context, &mut result.state, configuration, policy)?;
    if command.forward_move != 0.0 || command.side_move != 0.0 || command.up_move != 0.0 {
        let wish_velocity = add(
            add(
                scale(command.forward, command.forward_move),
                scale(command.right, command.side_move),
            ),
            [0.0, 0.0, command.up_move],
        );
        let uncapped = length(wish_velocity);
        let direction = normalized(wish_velocity);
        let speed = uncapped.min(command.maximum_speed);
        result.wish_state = WishState {
            direction,
            speed,
            uncapped_speed: uncapped,
        };
        let movement_surface_friction = surface_friction(result.state, policy);
        accelerate(
            &mut result.state.velocity,
            direction,
            speed,
            configuration.acceleration,
            tick,
            movement_surface_friction,
        );
    }
    if result.state.velocity[2] > 0.0 {
        set_ground(
            context,
            &mut result.state,
            None,
            &mut result.contacts,
            &mut result.events,
        )?;
    }
    if result.state.ground.is_some()
        && result.state.base_velocity == [0.0; 3]
        && result.state.velocity == [0.0; 3]
    {
        return Ok(());
    }
    clamp_velocity(&mut result.state.velocity, configuration.maximum_velocity);
    if result.state.mode == Mode::FlyGravity {
        add_gravity(&mut result.state, configuration, tick);
    }
    let total_velocity = add(result.state.velocity, result.state.base_velocity);
    let displacement = scale(total_velocity, tick);
    let hull = result.state.active_hull(policy);
    let trace = context.trace(
        QueryPurpose::TossDisplacement,
        result.state.position,
        add(result.state.position, displacement),
        hull,
        configuration.solid_mask,
    )?;
    result.state.position = trace.end;
    if trace.fraction < 1.0 && !trace.all_solid {
        record_contact(&mut result.contacts, trace, result.state.velocity);
    }
    if trace.all_solid {
        result.state.velocity = [0.0; 3];
        result.events.push(Event::Trapped);
        return Ok(());
    }
    if trace.fraction != 1.0 {
        let normal = trace
            .normal
            .ok_or_else(|| Error::new(Operation::Trace, FailureKind::Missing, "toss-plane"))?;
        let overbounce = if result.state.move_collision == MoveCollision::Bounce {
            2.0 - surface_friction(result.state, policy)
        } else {
            1.0
        };
        result.state.velocity = clip_velocity(result.state.velocity, normal, overbounce, configuration.clip_push_out);
        if normal[2] > configuration.standable_normal {
            if result.state.velocity[2] < configuration.gravity * tick {
                let ground = GroundState {
                    support: trace.hit,
                    normal,
                    surface_friction: policy.surface_friction,
                    jump_factor: policy.surface_jump_factor,
                };
                set_ground(
                    context,
                    &mut result.state,
                    Some(ground),
                    &mut result.contacts,
                    &mut result.events,
                )?;
                result.state.velocity[2] = 0.0;
            }
            if length_squared(result.state.velocity) < 900.0
                || result.state.move_collision != MoveCollision::Bounce
            {
                let ground = GroundState {
                    support: trace.hit,
                    normal,
                    surface_friction: policy.surface_friction,
                    jump_factor: policy.surface_jump_factor,
                };
                set_ground(
                    context,
                    &mut result.state,
                    Some(ground),
                    &mut result.contacts,
                    &mut result.events,
                )?;
                result.state.velocity = [0.0; 3];
            } else {
                let residual = scale(result.state.velocity, (1.0 - trace.fraction) * tick * 0.9);
                let residual_trace = context.trace(
                    QueryPurpose::TossDisplacement,
                    result.state.position,
                    add(result.state.position, residual),
                    hull,
                    configuration.solid_mask,
                )?;
                result.state.position = residual_trace.end;
            }
        }
    }
    check_water(context, &mut result.state, configuration, policy)?;
    Ok(())
}

struct QueryContext<'a, T: Tracer> {
    observe: bool,
    tracer: &'a T,
    sweeps: Vec<QueryRecord>,
    points: Vec<PointQueryRecord>,
    record: bool,
}

impl<'a, T: Tracer> QueryContext<'a, T> {
    fn new(tracer: &'a T) -> Self {
        Self {
            observe: false,
            tracer,
            sweeps: Vec::new(),
            points: Vec::new(),
            record: true,
        }
    }

    fn trace(
        &mut self,
        purpose: QueryPurpose,
        start: [f32; 3],
        end: [f32; 3],
        hull: Hull,
        mask: u32,
    ) -> Result<Trace, Error> {
        let result = self.tracer.trace(start, end, hull, mask)?;
        validate_trace(result)?;
        if !self.record {
            return Ok(result);
        }
        self.sweeps.push(QueryRecord {
            purpose,
            start,
            end,
            hull,
            mask,
            result,
        });
        Ok(result)
    }

    fn trace_without(
        &mut self,
        ignored: u64,
        purpose: QueryPurpose,
        start: [f32; 3],
        end: [f32; 3],
        hull: Hull,
        mask: u32,
    ) -> Result<Trace, Error> {
        let result = self.tracer.trace_without(ignored, start, end, hull, mask)?;
        validate_trace(result)?;
        self.sweeps.push(QueryRecord {
            purpose,
            start,
            end,
            hull,
            mask,
            result,
        });
        Ok(result)
    }

    fn point(&mut self, purpose: PointQueryPurpose, point: [f32; 3]) -> Result<u32, Error> {
        if point
            .iter()
            .any(|value| !value.is_finite() || value.abs() > MAX_COORDINATE)
        {
            return Err(Error::new(
                Operation::PointContents,
                FailureKind::Malformed,
                "point-contents-position",
            ));
        }
        let contents = self.tracer.point_contents(point)?;
        self.points.push(PointQueryRecord {
            purpose,
            point,
            contents,
        });
        Ok(contents)
    }
}

fn validate(
    state: State,
    input: StepInput,
    configuration: Configuration,
    policy: Policy,
) -> Result<(), Error> {
    validate_output(state, configuration)?;
    for (field, value, limit) in [
        (
            "forward",
            input.command.forward,
            Some(MAX_COMMAND_MAGNITUDE),
        ),
        ("side", input.command.side, Some(MAX_COMMAND_MAGNITUDE)),
        ("yaw", input.command.yaw_degrees, None),
        ("pitch", input.pitch_degrees, None),
        ("up", input.up, Some(MAX_COMMAND_MAGNITUDE)),
    ] {
        if !value.is_finite() || limit.is_some_and(|limit| value.abs() > limit) {
            return Err(
                Error::new(Operation::Validate, FailureKind::Malformed, field)
                    .with_value(value, limit),
            );
        }
    }
    let finite_nonnegative = [
        configuration.acceleration,
        configuration.air_acceleration,
        configuration.friction,
        configuration.stop_speed,
        configuration.gravity,
        configuration.lagged_movement_scale,
        configuration.step_height,
        configuration.step_epsilon,
        configuration.ground_probe,
        configuration.stay_ground_rise,
        configuration.ground_network_snap,
        configuration.maximum_velocity,
        configuration.server_max_speed,
        configuration.client_max_speed,
        configuration.surface_max_speed_factor,
        configuration.noclip_speed,
        configuration.spectator_speed,
        configuration.spectator_acceleration,
        configuration.bounce,
        configuration.ladder_distance,
        configuration.ladder_speed,
        configuration.ladder_lateral_factor,
        configuration.ladder_jump_speed,
        configuration.water_idle_sink_speed,
        configuration.water_wish_speed_factor,
        configuration.water_swim_speed,
        configuration.slime_swim_speed,
        configuration.water_exit_forward,
        configuration.water_exit_height,
        configuration.water_exit_down,
        configuration.water_exit_up_speed,
        configuration.water_exit_push_speed,
        configuration.water_exit_duration_ms,
        configuration.water_exit_maximum_ms,
        configuration.current_speed_per_level,
        configuration.roll_speed,
        configuration.fall_punch_threshold,
        configuration.floating_fall_reduction,
        configuration.stuck_retry_seconds,
        configuration.stuck_multiplayer_interval,
        configuration.stuck_singleplayer_interval,
        policy.maximum_speed,
        policy.air_speed_cap,
        policy.backward_speed_factor,
        policy.backward_speed_minimum,
        policy.ground_detach_speed,
        policy.jump_impulse,
        policy.surface_friction,
        policy.surface_jump_factor,
        policy.duck_duration,
        policy.unduck_duration,
        policy.crouched_command_factor,
        policy.water.waist_height_offset,
    ];
    let tick = configuration.tick_interval * configuration.lagged_movement_scale;
    let noclip_maximum = configuration.server_max_speed * configuration.noclip_speed;
    let invalid_constraint = configuration.movement_constraint.is_some_and(|constraint| {
        constraint.center.iter().any(|value| !value.is_finite())
            || !constraint.radius.is_finite()
            || constraint.radius < 0.0
            || !constraint.width.is_finite()
            || constraint.width < 0.0
            || constraint.width > constraint.radius
            || !constraint.outward_speed_factor.is_finite()
            || constraint.outward_speed_factor < 0.0
    });
    if !configuration.tick_interval.is_finite()
        || configuration.tick_interval <= 0.0
        || configuration.tick_interval > 1.0
        || finite_nonnegative
            .iter()
            .any(|value| !value.is_finite() || *value < 0.0)
        // bunnyhop patch: the entity gravity multiplier may be negative (CBaseEntity "gravity" keyvalue is a plain
        // atof; bhop_alt_saimaa's jump pad sets -0.5 and the real engine accelerates the player upward).
        || !configuration.gravity_scale.is_finite()
        || !configuration.noclip_acceleration.is_finite()
        || configuration.noclip_acceleration.abs() > 1_000.0
        || !configuration.roll_angle.is_finite()
        || configuration.maximum_velocity <= 0.0
        || policy.maximum_speed > configuration.maximum_velocity
        || policy.air_speed_cap > configuration.maximum_velocity
        || policy.ground_detach_speed > configuration.maximum_velocity
        || policy.air_dash_impulse.is_some_and(|impulse| {
            !impulse.is_finite() || impulse < 0.0 || impulse > configuration.maximum_velocity
        })
        || !(0.0..=1.0).contains(&policy.backward_speed_factor)
        || !(0.0..=1.0).contains(&policy.crouched_command_factor)
        || !configuration.standable_normal.is_finite()
        || !(0.0..=1.0).contains(&configuration.standable_normal)
        || !tick.is_finite()
        || tick <= 0.0
        || !noclip_maximum.is_finite()
        || noclip_maximum > configuration.maximum_velocity
        || policy.bunnyhop_speed_cap.is_some_and(|value| {
            !value.is_finite() || value < 0.0 || value > configuration.maximum_velocity
        })
        || invalid_constraint
        || !valid_hull(policy.standing_hull)
        || !valid_hull(policy.crouched_hull)
        || configuration
            .observer_hull
            .is_some_and(|hull| !valid_hull(hull))
        || !hull_straddles_origin(policy.standing_hull)
        || !hull_straddles_origin(policy.crouched_hull)
        || policy
            .standing_view
            .into_iter()
            .chain(policy.crouched_view)
            .any(|value| !value.is_finite() || value.abs() > MAX_COORDINATE)
    {
        return Err(Error::new(
            Operation::Validate,
            FailureKind::Malformed,
            "configuration",
        ));
    }
    Ok(())
}

fn validate_output(state: State, configuration: Configuration) -> Result<(), Error> {
    let vectors = state
        .position
        .into_iter()
        .chain(state.velocity)
        .chain(state.base_velocity)
        .chain(state.local_angles)
        .chain(state.absolute_view_angles)
        .chain(state.ladder_normal)
        .chain(state.view_offset)
        .chain(state.water_jump_velocity);
    if vectors.into_iter().any(|value| !value.is_finite())
        || state
            .position
            .iter()
            .any(|value| value.abs() > MAX_COORDINATE)
        || state
            .velocity
            .iter()
            .any(|value| value.abs() > configuration.maximum_velocity)
        // bunnyhop patch: base velocity isn't bounded by sv_maxvelocity in Source (CheckVelocity clamps
        // only the velocity); a trigger_push faster than 3500 (bhop_exceptional's 10000 u/s booster) is valid.
        || !(0.0..=1.0).contains(&state.crouch.fraction)
        || !(0.0..=1.0).contains(&state.crouch.linear_fraction)
        || !state.crouch.elapsed.is_finite()
        || state.crouch.elapsed < 0.0
        || !state.crouch.duration.is_finite()
        || state.crouch.duration < 0.0
        || !state.stamina_ms.is_finite()
        || state.stamina_ms < 0.0
        || state.stamina_ms > (25.0 / 19.0) * 1000.0
        || !state.fall_speed.is_finite()
        || state.fall_speed < 0.0
        || state.water_level > 3
        || !state.water_jump_time_ms.is_finite()
        || state.water_jump_time_ms < 0.0
        || !state.previous_forward.is_finite()
        || !state.stuck_next_check_time.is_finite()
        || state.stuck_offset as usize >= STUCK_OFFSETS
        || !state.surface_friction.is_finite()
        || state.surface_friction < 0.0
    {
        return Err(Error::new(
            Operation::Validate,
            FailureKind::Malformed,
            "state",
        ));
    }
    Ok(())
}

fn validate_trace(trace: Trace) -> Result<(), Error> {
    let normal_valid = trace.normal.is_none_or(|normal| {
        normal.iter().all(|value| value.is_finite())
            && (0.9..=1.1).contains(&length_squared(normal))
    });
    if !trace.fraction.is_finite()
        || !(0.0..=1.0).contains(&trace.fraction)
        || trace.end.iter().any(|value| !value.is_finite())
        || !normal_valid
    {
        return Err(Error::new(
            Operation::Trace,
            FailureKind::Malformed,
            "trace-result",
        ));
    }
    Ok(())
}

fn valid_hull(hull: Hull) -> bool {
    hull.mins
        .into_iter()
        .chain(hull.maxs)
        .all(|value| value.is_finite() && value.abs() <= MAX_COORDINATE)
        && hull
            .mins
            .into_iter()
            .zip(hull.maxs)
            .all(|(minimum, maximum)| minimum <= maximum)
}

fn hull_straddles_origin(hull: Hull) -> bool {
    hull.mins[0] <= 0.0 && hull.maxs[0] >= 0.0 && hull.mins[1] <= 0.0 && hull.maxs[1] >= 0.0
}

fn standable(trace: Trace, threshold: f32) -> bool {
    !trace.start_solid
        && !trace.all_solid
        && trace.fraction < 1.0
        && trace.normal.is_some_and(|normal| normal[2] >= threshold)
}

fn quadrants(hull: Hull) -> [Hull; 4] {
    [
        Hull {
            mins: hull.mins,
            maxs: [hull.maxs[0].min(0.0), hull.maxs[1].min(0.0), hull.maxs[2]],
        },
        Hull {
            mins: [hull.mins[0].max(0.0), hull.mins[1].max(0.0), hull.mins[2]],
            maxs: hull.maxs,
        },
        Hull {
            mins: [hull.mins[0], hull.mins[1].max(0.0), hull.mins[2]],
            maxs: [hull.maxs[0].min(0.0), hull.maxs[1], hull.maxs[2]],
        },
        Hull {
            mins: [hull.mins[0].max(0.0), hull.mins[1], hull.mins[2]],
            maxs: [hull.maxs[0], hull.maxs[1].min(0.0), hull.maxs[2]],
        },
    ]
}

fn stuck_offsets() -> [[f32; 3]; STUCK_OFFSETS] {
    let mut offsets = [[0.0; 3]; STUCK_OFFSETS];
    let mut index = 0;
    for z in [-0.125, 0.0, 0.125] {
        offsets[index] = [0.0, 0.0, z];
        index += 1;
    }
    for y in [-0.125, 0.0, 0.125] {
        offsets[index] = [0.0, y, 0.0];
        index += 1;
    }
    for x in [-0.125, 0.0, 0.125] {
        offsets[index] = [x, 0.0, 0.0];
        index += 1;
    }
    for x in [-0.125, 0.125] {
        for y in [-0.125, 0.125] {
            for z in [-0.125, 0.125] {
                offsets[index] = [x, y, z];
                index += 1;
            }
        }
    }
    for z in [0.0, 1.0, 6.0] {
        offsets[index] = [0.0, 0.0, z];
        index += 1;
    }
    for y in [-2.0, 0.0, 2.0] {
        offsets[index] = [0.0, y, 0.0];
        index += 1;
    }
    for x in [-2.0, 0.0, 2.0] {
        offsets[index] = [x, 0.0, 0.0];
        index += 1;
    }
    for z in [0.0, 1.0, 6.0] {
        for x in [-2.0, 0.0, 2.0] {
            for y in [-2.0, 0.0, 2.0] {
                offsets[index] = [x, y, z];
                index += 1;
            }
        }
    }
    debug_assert_eq!(index, 53);
    offsets
}

fn record_contact(contacts: &mut Vec<Contact>, trace: Trace, impact_velocity: [f32; 3]) {
    if let Some(normal) = trace.normal {
        record_contact_from_parts(contacts, trace.hit, normal, impact_velocity);
    }
}

fn record_contact_from_parts(
    contacts: &mut Vec<Contact>,
    hit: Option<u64>,
    normal: [f32; 3],
    impact_velocity: [f32; 3],
) {
    if contacts.iter().any(|contact| contact.hit == hit) {
        return;
    }
    contacts.push(Contact {
        hit,
        normal,
        impact_velocity,
        order: contacts.len() as u8,
    });
}

fn movement_roll(
    pitch: f32,
    yaw: f32,
    velocity: [f32; 3],
    roll_angle: f32,
    roll_speed: f32,
) -> f32 {
    if roll_speed == 0.0 {
        return 0.0;
    }
    let (_, right, _) = angle_basis(pitch, yaw, 0.0);
    let side = dot(velocity, right);
    let sign = if side < 0.0 { -1.0 } else { 1.0 };
    sign * if side.abs() < roll_speed {
        side.abs() * roll_angle / roll_speed
    } else {
        roll_angle
    }
}

fn angle_basis(
    pitch_degrees: f32,
    yaw_degrees: f32,
    roll_degrees: f32,
) -> ([f32; 3], [f32; 3], [f32; 3]) {
    let (pitch_sine, pitch_cosine) = playsrc_collision::math::sin_cos(pitch_degrees.to_radians());
    let (yaw_sine, yaw_cosine) = playsrc_collision::math::sin_cos(yaw_degrees.to_radians());
    let (roll_sine, roll_cosine) = playsrc_collision::math::sin_cos(roll_degrees.to_radians());
    let forward = [
        pitch_cosine * yaw_cosine,
        pitch_cosine * yaw_sine,
        -pitch_sine,
    ];
    let right = [
        -roll_sine * pitch_sine * yaw_cosine + roll_cosine * yaw_sine,
        -roll_sine * pitch_sine * yaw_sine - roll_cosine * yaw_cosine,
        -roll_sine * pitch_cosine,
    ];
    let up = [
        roll_cosine * pitch_sine * yaw_cosine + roll_sine * yaw_sine,
        roll_cosine * pitch_sine * yaw_sine - roll_sine * yaw_cosine,
        roll_cosine * pitch_cosine,
    ];
    (forward, right, up)
}

fn clip_velocity(input: [f32; 3], normal: [f32; 3], overbounce: f32, push_out: f32) -> [f32; 3] {
    let backoff = dot(input, normal) * overbounce;
    let mut output = sub(input, scale(normal, backoff));
    let adjustment = dot(output, normal);
    if push_out > 0.0 {
        // bunnyhop patch: CS:S push-out (see `Configuration::clip_push_out`).
        if adjustment <= 0.0 {
            output = sub(output, scale(normal, adjustment.min(-push_out)));
        }
    } else if adjustment < 0.0 {
        output = sub(output, scale(normal, adjustment));
    }
    output
}

fn clamp_velocity(velocity: &mut [f32; 3], maximum: f32) {
    for value in velocity {
        if value.is_nan() {
            *value = 0.0;
        }
        *value = value.clamp(-maximum, maximum);
    }
}

fn cap_horizontal_speed(velocity: &mut [f32; 3], maximum: f32) {
    let speed = (velocity[0] * velocity[0] + velocity[1] * velocity[1]).sqrt();
    if speed > maximum && speed > 0.0 {
        let factor = maximum / speed;
        velocity[0] *= factor;
        velocity[1] *= factor;
    }
}

fn cap_vector_speed(velocity: &mut [f32; 3], maximum: f32) {
    let speed = length(*velocity);
    if speed > maximum && speed > 0.0 {
        *velocity = scale(*velocity, maximum / speed);
    }
}

fn horizontal_distance_squared(a: [f32; 3], b: [f32; 3]) -> f32 {
    (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)
}

fn simple_spline(value: f32) -> f32 {
    let squared = value * value;
    // bunnyhop patch: f32 rounding can yield 1.0000001 just below value == 1 (e.g. 0.4 s duck at
    // 100 tick), which validate_output rejects as a malformed crouch fraction.
    (3.0 * squared - 2.0 * squared * value).clamp(0.0, 1.0)
}

fn normalize_in_place(vector: &mut [f32; 3]) -> f32 {
    let magnitude = length(*vector);
    if magnitude > 0.0 {
        *vector = scale(*vector, 1.0 / magnitude);
    }
    magnitude
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn add(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn scale(vector: [f32; 3], factor: f32) -> [f32; 3] {
    [vector[0] * factor, vector[1] * factor, vector[2] * factor]
}

fn length_squared(vector: [f32; 3]) -> f32 {
    dot(vector, vector)
}

fn length(vector: [f32; 3]) -> f32 {
    length_squared(vector).sqrt()
}

fn normalized(vector: [f32; 3]) -> [f32; 3] {
    let magnitude = length(vector);
    if magnitude > 0.0 {
        scale(vector, 1.0 / magnitude)
    } else {
        [0.0; 3]
    }
}
