# Changelog

## v0.7.2 — Native

Update from Settings → Updates: press Update, then Restart to update. Your settings, replays and maps are kept.

**Ranked**
- Physics v25 and timer rules 4, matching website v0.0.37. Your existing runs don't change.
- Every jump starts 1.5 units above the floor, as on Momentum and on CS:S servers with a landfix, so a jump goes the
  same height every time. Crouch jumps onto ledges right at the height limit, like the long platform on
  bhop_tranquility, now work every time instead of depending on how you landed.
- Ramps and curves no longer stop you dead or freeze you in mid-air: the quarter-pipe on bhop_badges_mini, the drop
  shaft on bhop_kotodama and the last stage of bhop_aux_a9 play smoothly now.

**A/D-Only**
- New style: A/D-Only (`!ad`, also `!a`, `!d`, `!aonly`, `!donly` and `!adonly`). Strafe with only A or only D in the
  air: the first one you use in a run is the only one that works, and W and S do nothing. It has its own boards, like on
  the website.

**Tiers and rewards**
- Map tiers go up to T10: T8 Brutal, T9 Nightmare, T10 Impossible, on the Tab board too.
- A mark after your name shows the hardest tier you've cleared, in game as well as in the menu.
- New tier rewards: the Flare, Riptide and Whiteout colourways, their trails, the Riptide ghost, card frames and
  backgrounds, and the Silver Wreath, plus the Lapis set for T7. The achievements Deep End, Sleepless and True Architect
  are in too.

**Supporter looks**
- Supporters' name fonts show in game as on the website: on the Tab board, name tags, chat and the spectating bar. The
  spectating bar also shows the watched player's name colour and effect.
- Edit card has the new supporter choices: name font, avatar decoration, card border and effects.

**Chat**
- Profile flags can be pride flags, shown on the Tab board, name tags and chat.
- Chat commands work with a Russian layout on (`!ызус` is `!spec`) and with a dot in front (`.rtv`).
- After a style command, chat says how to get back to Normal.
- Menus you open from chat (`!spec`, `!race`, `!bright`) can be clicked.
- `!bright` opens a quick menu for this map's brightness and Fullbright, and `!fb` switches Fullbright. Both are kept
  per map; Settings → Graphics keeps the value for every other map.

**Third person**
- Everyone is the bunny, as on the website: the classic runner and the player and ghost model settings are gone.
- Feet plant and step when you stop and turn, legs tuck and reach in the air, landings sink with how hard they were,
  and the bunny leans into strafes, climbs ladders and swims. Its ears twitch the same way in every replay.
- Feet stay planted on slopes and stairs and tilt with the ground, and the bunny steps up and down ledges instead of
  standing in the air.
- Ghosts and other players swim in water and climb ladders, ghosts lean into strafes and pick up their motion when a
  run restarts, and replays show the bunny moving smoothly on high refresh rate screens.
- Distant players and ghosts keep a readable outline.
- The chase camera rises over your shoulder in tight corridors and no longer pumps against walls. Seeking in a replay
  or starting a video export puts the camera and the bunny where playback would have them.

**First person**
- The website's weapons pass: the knife and gun move like on the website (CS:S bob, lag, strafe tilt, landing dip), the
  old weapon lowers out while the new one draws, attacks blend an inspect out instead of cutting it, and your hand
  idles between actions. The USP's suppressor arm, rifle grips and gloves are fixed too.
- The M4A1 has its own suppressor, with its own attach and detach timing and sounds.
- Settings → Viewmodel: Inspect can be Quiet (your first press only checks the knife; replays always show the tricks),
  and Hard landing settle and Speed FOV are new, both off by default.
- With your system's reduce motion setting on, the hands and guns move less, like on the website.
- Viewmodel bob now defaults to 0.5. If you never changed it, it moves to 0.5 once; your own value stays.

**Maps**
- Animated map props move like in CS:S, such as bhop_ceaseless's butterflies and bhop_retrowave's blocks, and the
  map's own triggers can hide them. Props that switch idle animations at random (bhop_shrubhop, bhop_hive's thumpers)
  animate like on the website.
- New hard maps bhop_hellopro2 (T8) and bhop_4triedsame (T10): stay on a one-hop block, or land on the same spot again
  within 4 seconds, and you're sent back, as on CS:S.
- Frame-animated and scrolling textures animate, at the map's own speed and angle (bhop_umbra's moon clouds no longer
  race), and bhop_4triedsame's wireframe shaft draws.
- Maps with many props draw faster: on bhop_retrowave the world takes about a third less time per frame.

**Replays**
- Head-to-head links (`/h2h/…`) open in the replay viewer: the first run plays and the second rides along as the compare
  ghost, with the time ahead or behind.

**Fullscreen**
- If fullscreen or borderless doesn't show, the game goes back to windowed by itself and keeps that. A game that froze
  or was closed while switching starts windowed next time and tells you why.
- Windows: Fullscreen at your desktop's resolution no longer switches the monitor's mode, so Esc no longer turns the
  screen black for a moment. Coming back to the menu from another resolution, the window fills the screen again instead
  of looking windowed. We haven't seen this on a real PC yet, so tell us if Esc still goes black.
- Start the game with `--windowed` to force windowed and keep it. The README says how on Windows, macOS and Linux.

**Updates**
- The game checks for a new version when it starts and every few hours while it runs. When one is out, the home screen
  says so: Update downloads it, then Restart to update installs it. Not now hides it until the next version.

## v0.7.1 — Native

Update from Settings → Updates: press Update, then Restart to update. Your settings, replays and maps are kept.

**Ranked**
- Physics v24 and timer rules 4, matching website v0.0.36. Your existing runs don't change.
- Runs on bhop_playboy_csgo, bhop_dtt_trainning2, bhop_futile and bhop_4tele count again, with the website's map
  fixes. bhop_futile blocks prehops in the start zone, like CS:S servers: leave it with one jump.
- Clips never run out, on every map, so maps you shoot to boost don't stop for a reload.
- bhop_2_S4RO, bhop_alt_jestas, bhop_dust_temple and bhop_mourning show their real lighting.

**Infinite**
- Noclip through the start for speed now counts, as on the website: fly through, drop out of noclip and cross the start
  for real. The run starts with the speed you built, up to 3510. Before, a flight ended your recording.
- A landing that noclip moves out of the start doesn't start the run. Land in the start, then leave it.

**Backwards**
- New style: Backwards (`!bw`). In the air, face away from where you're going, or your movement keys don't count. It has
  its own boards, like on the website.

**Spectating**
- N opens a list of players to watch, as does `!spec` with no name. R, B or M stops watching.
- Space or F switches between in-eye, chase and free look. Left and right click switch players.
- Spectating no longer leaves third person on, which used to turn your next attempt into practice.

**Freecam**
- `!freecam` (or `!fc`, or bind it in Settings → Keys) flies the camera ahead to look at the map while your body coasts.
  The timer keeps running and the run still counts.

**Servers**
- Practice, checkpoints and Segmented work on servers. Players who are practising show "practice" instead of a time, and
  `!hide` hides everyone else.
- You can save up to 1000 checkpoints.
- One player in Segmented or Infinite no longer freezes everyone else on your screen, and every style shows on the Tab
  board and name tags.
- Number keys go to the menu that's open. With a vote or the spectate list on screen, they no longer change your gun.

**Jump stats**
- `!ssj 80` shows only jumps with 80% gain or more, also in Settings → HUD → Jump stats.

## v0.7.0 — Native

### Added anti-piracy
Don't even ask, look through the code if you want to find out what I mean...

### Added Infinite
Infinite (`!inf`) is a style I made [a while ago](https://github.com/2x74/infinite). Essentially, you jump in midair,
and noclip through the start for prespeed.

- Autohop on the ground. In the air, every jump press sends you up again and keeps your speed, as many times as you
  want. Scroll is faster than space here, that's the point.
- Noclip flies at 3500 instead of 1600, and it doesn't dump you into practice like it does in every other style.
- Fly through the start to build speed, then drop out of noclip and cross it for real: the run starts with whatever
  you built, from the air or the ground.
- Capped at 3510 so you can't just loop the start over and over.
- The timer won't start while you're still noclipped, so no, you can't fly to the end.

### Three binds
You can bind three keys to anything now instead of two.

## v0.6.5 — Native

Update from Settings → Updates: press Update, then Restart to update. Your settings, replays and maps are kept.

**Ranked**
- Physics v23 and timer rules 3, matching website v0.0.34. Your existing runs don't change.
- bhop_handsuplol and bhop_nuclear: a booster at the edge of the start zone keeps its speed when you walk out.
- bhop_trampislow: the short floor booster launches you as hard as it does on CS:S servers.
- bhop_crutle5_css: the teleporter at the end of the first level works now.
- bhop_benchmark: one block no longer sends you 20 minutes back.
- kz_ maps: anti-hop blocks and other timed triggers now match CS:S timer servers. You can jump 0.05 s sooner, and blocks
  that teleport you if you stay too long fire 0.05 s sooner.

**Submitting**
- Your version keeps submitting when the website updates, as long as the server still accepts it. Before, a website
  update could stop older versions uploading even though their runs were still welcome.
- If the server can't take your run yet, your run waits while the game stays open and uploads by itself once it can, for
  up to a day. That covers a version it doesn't accept, a shared network at its limit for new players, and more runs
  than the last hour allows. The replay stays saved either way.
- Refused uploads now show the server's reason. If your files don't match the release, usually from unpacking over an
  older version, the message tells you to unpack into an empty folder.

**Strafe trainer**
- The Bar look, as on the website, in Settings → HUD → Strafe trainer. Its colour is the speed you really gained that
  tick: red for a loss, white for none, then orange, green and blue as you get closer to the best possible.

**Start points**
- A start point just over the zone's edge now moves into the zone and counts.
- A spawn that won't count says so for the whole attempt, and !clearstart takes you straight back to the real start.

**Windows**
- The game no longer opens a terminal window. The log is in Settings → Game data, and `--console` opens a terminal
  for support. Video export doesn't flash one either.
- The game now asks Windows to draw its modern window frame instead of the Windows 7 style one. We haven't seen this on
  a real PC yet, so tell us if the old frame is still there.

**Movement**
- Release W on jump, as on the website: a jump taken holding W lets go of forward until you land or press W again. It's
  off until you turn it on, and doesn't apply to Legit Scroll, W-Only, Sideways or Half-Sideways.

## v0.6.4 — Native

Update from Settings → Updates: press Update, then Restart to update. Your settings, replays and maps are kept.

**Ranked**
- Physics v22, matching website v0.0.33: Momentum's edge rule. A landing with no ground under your next tick is taken
  back unless you jump, so it costs no friction tick.

**Accounts**
- Sign in with your name and a password, or add a password to your account in Account. Forgot password works through
  the Discord or email on your account.
- Guests can save their progress with just a password, and a guest's new best offers it: press Esc after the run.
- Password accounts no longer read "Signed in with Discord".
- The security check some sign-ins ask for can't load in the native client. If you get it, sign in with email or
  Discord instead.

**Map loading**
- Fixed on Windows: Play, Settings and other menu buttons could stop responding after opening Ranks or Gauntlets, until
  you restarted the game.
- A map download that stalls now ends in an error with Retry instead of waiting forever, and big maps on a slow
  connection no longer hit a time limit.
- A failed map load always tells you why.

**Log file**
- The game now keeps a log file. If something goes wrong, open Settings → Game data → Open log folder and send us
  `bunnyhop-native.log`. It leaves out your account details and your computer's username.

**Third person**
- You now see your own knife swing in third person and in replays and video exports. A compare ghost swings too.
- Other players no longer play a knife swing when they fire a gun, and a third-person gun's kick no longer stacks.

**HUD**
- Fixed Ctrl and other keys staying lit on the key overlay after a restart.
- The run stats' average FPS now goes past 1000.

## v0.6.3 — Native

Update from Settings → Updates: press Update, then Restart to update. Your settings, replays and maps are kept.

**Ranked**
- Physics v21, matching website v0.0.32: bhop_wayz's doors follow their rotator, so level 10 can be finished; a door
  that starts open on bhop_collective spawns open; and the green train on bhop_areaportal_v1 stops turning you around.
- Doors and props now rest in their proper pose on 123 maps, such as the corridor doors on bhop_mirrorsedge_chpt1.

**Camera and clock**
- The camera no longer goes through low ceilings. Under one, your view stays 12 units below it, as in CS:S. This
  moves only what you see: physics and ranked runs are unchanged.
- The HUD clock counts while you bhop in the start zone instead of showing 0 until you leave it.

**Map sounds**
- Maps now play approved ambience and soundscapes, placed in the map and fading with distance. Settings → Audio has
  a Map sounds volume and mute.

**HUD**
- JHUD: type `!jhud` to see the speed and gain of every jump near your crosshair, coloured by how it went, with
  optional sync, JSS and a strafe arrow. It's off until you turn it on; Settings → HUD → JHUD has its colours, and
  the layout editor moves it.
- Speed difference: your speed against your race ghost's at the same point on its route, beside your speed. Turn it
  on in Settings → Ghost → Compare.
- Compare with: pick the ghost your split and speed difference use. The split now stays on the lap or level you're
  on, as on the website.
- Maps with unconfirmed or incomplete zones say so in the map panel and once when they load.

## v0.6.2 — Native

This is the last version you need to download by hand: from here on, Settings → Updates updates the game for you.

**HUD and menus**
- The HUD and menus are back to the v0.5.1 look, and nothing overlaps any more. The FPS counter, IN START, run
  stats and key labels each keep their own place at every screen size and HUD scale.
- New HUD layout editor: press F2, or Settings → HUD → Edit layout. Drag and resize anything, snap to a grid or the
  centre lines, nudge with the arrow keys, hide elements, pick a preset (Classic, Minimal, Streamer), and copy or
  paste a layout code that also works on the website.
- The strafe trainer has the website's three styles: Classic, Detailed and Minimal.
- SSJ, jump stats and the strafe trainer show the same numbers and colours as the website.
- The crosshair is drawn in whole pixels at the website's size, so its lines match on every screen, including
  borderless on Windows.
- Settings → Paint: colours, sizes, Clear paint and the paint keys, which now save. Holding the paint key places
  marks smoothly, and marks have soft edges.

**Graphics**
- Enhanced and Cinematic looks, with bloom, haze, sun shafts, contact shading, sun shadows and edge smoothing.
- Custom skies, as on the website: the seven built-in skies, Poly Haven links, .hdr files and 2:1 panoramas, a skies
  folder in your game data, and sky rotation, brightness and lighting.
- The v0.0.29 bunny, gloves, sleeves and guns, the wigs, the Half Oni Mask and the metal knife finishes. Other
  players and replays wear their own loadout.
- Water no longer shows as a pale slab. In the Source look it refracts and, with Water reflections on, reflects the
  map and players. Skybox seams and pale halos around leaves are gone.
- Ghosts, trails and the route guide work like the website's.

**Cosmetics**
- Knife pool, as on the website: up to 8 knives with their finishes that swap each map or each restart, in order or
  at random. Set it up in Loadout → Knife; it saves to your account, and other players and your replays see the knife
  you're holding.
- New knife: Whirligig, with its spinner, its draw and three inspects (Flick, Pinwheel, Backspin).
- The rebuilt Karrotbit, with its ring twirl on the draw.
- Ponytails go up to 300% long.
- Knife inspects make their flick, spin and catch sounds, and the Bunnyfly's blade shows in first person.

**Display and input**
- Exclusive fullscreen: pick the monitor, resolution and refresh rate, then keep it or it switches back after 10
  seconds. True 4:3 stretched or black bars.
- Windows: Low latency mode with NVIDIA Reflex (Off, On, On + Boost) and the Reflex flash indicator.
- Steadier frame pacing at an FPS limit, and keys no longer stick after the menu or chat takes focus.
- macOS and Linux: optional direct mouse input (Settings → Mouse). Show input stats says which one you're using.

**Multiplayer**
- The Tab scoreboard matches the website: style names, running and finished times, a HOST tag, and spectators
  listed under the table.
- Chat shows the website's join, leave, record and host lines. Chat is now a key you can rebind (Y and U by default).
- Name tags above players show their name colour, badges and time, and fade with distance and behind walls.
- Other players hold guns with both hands, with kick, reloads, muzzle flashes and tracers, and move smoothly at any
  frame rate.

**Replays and video**
- The replay viewer keeps playing while it's open, with a smooth camera, an orbit camera, loops (L), next jump or
  split (J, N), Go to (G), and the runner's own screen shape and FOV (R).
- Video export runs in the background without freezing the game: the website's presets, motion blur, 4K and 8K, up
  to 240 fps, H.264, HEVC and AV1, ProRes, DNxHR and lossless, hardware encoding, a queue, and export straight
  from the Replays list. It needs FFmpeg installed.

**Ranked**
- Physics v20 for v0.0.30's new maps and their mechanics.
- Crouch-cancelling or landing from a teleport onto a floor no longer costs a tick of friction: you jump on the same
  tick, like bhoptimer servers.
- `!showtriggers` shows the scripted ingredients and gates on bhop_cooksassistant.
- The Segmented style (`!seg`), as on the website: press C to save and X to load during the run. The time and the
  replay keep only the path you finished on, and Segmented has its own boards.
- Runs with null binds count for ranked, as on the website.
- Leaderboard hover cards show your FPS, polling rate, sensitivity and native version.
- `!practice off` clears the map's practice spawns, as on the website.
- Fixed runs being rejected on maps where a texture changes the floor's friction, such as bhop_cyx_jump.

**Account and app**
- Edit avatar opens an editor in the game and saves to the account you're signed in to.
- Settings → Updates: Update, then Restart to update. Your settings, replays and maps are kept.
- Maps no longer get stuck downloading. A failed download shows an error, and Retry works.
- Windows: the zip shows its files in Explorer before you extract it.

## v0.6.1 — Native

**Fixes**
- Frame rate is back up while you play. The timer, speed, FPS counter and run stats no longer redraw their text from
  scratch every frame; in 0.6.0 that cost most of the frame on Windows.

## v0.6.0 — Native

**Input**
- Mouse movement and key presses now count in the tick they happened in, using each event's timestamp, the same
  way the website does. Quick A/D taps and strafes no longer get dropped or land late at low or uneven frame rates.
- Windows reads the keyboard through raw input while you play, and keys no longer stick after the menu takes focus.
- New installs start with VSync off and a 1000 FPS limit.
- Settings → Mouse → Show input stats shows reports per second, event age and frame timing, and flags stalls.

**Menus and settings**
- Settings is now the website's settings screen, with the same search, sections and presets. Rows the native
  renderer can't use are hidden or say why.
- New installs use the website's default binds: fast turn ↑, noclip Z, third person T, show clips unbound.
- Custom CSS, the replay viewer, credits and account screens match the website.
- The finish card looks like the website's: your time, PB or record, delta, rank, and XP and unlocks once the run
  is verified. The HUD shows your board place ("#4 · top 3%").
- The scoreboard, chat, name tags and notifications follow the website's styles. The Runner player model is
  retired, as on the website.

**v0.0.29**
- Turn speed (`cl_yawspeed`, 60–720°/s) and the fast-turn multiplier (1–4) are saved with your replay.
- Times are scored in milliseconds, matching the server.
- Practice from any point of a replay, and replays open trimmed to the run.
- Ghost colours, trails and glow, replay Compare and the timeline match the website.

**Fixes**
- Borderless and fullscreen switching no longer hides the menu.
- Settings no longer reset after a crash or a bad keybind, and settings files save safely.
- Paths with non-English characters work.

## v0.5.1 — Native

**Fixes**
- Custom spawns (`!ss` / `!setspawn`) now actually apply when you restart. Before,
  the game said the spawn was saved but restarts ignored it.
- Windows: **Borderless windowed** is now a real borderless window, so it no longer
  turns into exclusive fullscreen (which could hide the menu and stop you moving).
- Settings import accepts the website's settings code (`bhs1.…`) as well as JSON,
  and the import box is bigger.

## v0.5.0 — Native

**Gameplay**
- Setspawn (`!ss` / `!setspawn`) now works in practice and anywhere you're standing
  still. A spawn outside the start zone restarts as a practice run, and the timer
  still starts from the start zone.
- Noclip (`!nc`) works in normal and practice runs, including mid-run, and stops a
  running timer.
- `!showtriggers` and `!showclips` now toggle triggers and player clips separately.
  Both are also in Settings and can be bound.

**HUD and audio**
- JHUD colours by gain, on by default: red under 60%, orange 60–69%, green 70–79%,
  cyan 80–89%, white 90% and up. Turn it off in Settings → Jump stats colours.
- The PERFECT indicator and perf % now only show in EZ Scroll and Legit Scroll.
- New **Weapon sounds** toggle covering gunfire, knife swings and stabs, reloads and
  impacts.

**Settings**
- **Settings → Game data:** move your game data to another folder or drive, either
  now or on the next launch.
- New default binds: noclip is now `` ` `` (was Z), show triggers is Mouse 3, show
  clips is T.

**Fixes**
- Fullscreen no longer leaves the menu invisible: the game runs borderless while the
  menu is open. The new `--windowed` launch flag resets a display mode you can't get
  out of.
- The practice-mode hint now shows your actual binds.
- Turnbinds at any speed are no longer held back by the client outside Legit Scroll:
  runs are submitted and the server decides whether they rank (it ranks 210°/s).
  In Legit Scroll, turnbinds still only work in practice.

**Security**
- Classic CS:S sounds only ever decode as WAV, and an Ogg Vorbis decoder overflow
  (CVE-2023-45678) is patched.

## Unreleased — current-server compatibility

- Update the shared simulation to physics 15 and pin the matching canonical WASM.
- Decode BHR v10 fractional look data and manual-turn rebases for replay playback.
- Queue SDL mouse reports by simulation tick deadlines and preserve GL contexts
  around GTK menu work.
- Bind ranked attempts to confirmed accounts through actual HTTP dispatch and
  preserve completed uploads across gameplay restarts.
- Harden Linux package library paths and dependency closure; retain standalone
  release resource builds and platform-specific packaging fixes.
- Refresh shared menu/protocol modules. No release publication or score admission
  is included; see [qualification notes](docs/current-compatibility.md).

## v0.0.1 — Native preview

- Introduces the C++20/SDL3/OpenGL native client, linked to the shared Rust game
  core for movement, collision, timer rules, command recording and BHR replays.
- Keeps gameplay rendering and input native, with embedded web menus for accounts,
  maps, leaderboards, settings and network services.
- Adds eight styles, persistent native settings/binds, local replay playback and
  ghosts, tutorial coaching, native HUD/audio, cosmetics and multiplayer rooms.
- Adds native packaging, package identity/checksum checks and automated platform
  build targets. macOS ARM64 has been built and smoke-tested; other platform
  results belong in the release notes as they complete.
- Establishes an unsigned preview policy: ad-hoc macOS bundles, unsigned Windows
  and Linux packages, manual updates, and no active update signing keys.
- Retains server verification and the exact release allowlist requirement for
  ranked uploads. Replays stay local when a build is not admitted.
- Makes this repository's documentation native-first while retaining the legacy
  Electron implementation and original attribution.

This is an early preview, not complete website parity. No FPS or input latency
improvement is established. See [README.md](README.md) for limitations and
[Releases](https://github.com/2x74/bunnyhop-client/releases) for available artifacts
and validation results.

## Earlier Electron development

The legacy shell added Bunnyhop branding, display/settings profiles, diagnostics,
screenshots, a bounded run-summary vault, optional Discord Rich Presence,
validated deep links/downloads and a permanent hash-verified content cache.
Its source package version `0.1.0` predates the native release version and is not
the native v0.0.1 package identity. The earlier
[documentation](https://github.com/2x74/bunnyhop-client/blob/321e746/README.md)
remains available in repository history.
