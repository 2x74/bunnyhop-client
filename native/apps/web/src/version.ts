/* ============================================================
   bunnyhop.lol — the version, and what each one changed
   ============================================================

   One number the home screen and the pause menu print, and one list
   the changelog card (ui/changelog.ts) and the static /changelog page
   (changelog.html, filled in at build time by vite.config.ts) read.
   Both live here, in source, rather than being generated from git: a
   commit log is written for the person merging it, and the changelog
   is read by a player who wants to know whether the map they got stuck
   on yesterday is fixed. Those are different documents.

   THE NUMBER IS PLAYER-FACING AND SMALL ON PURPOSE. bunnyhop.lol
   launched on 2026-10-04 and nothing about it has been called stable:
   it is an alpha, the UI says "alpha" next to the number, and it stays
   in 0.0.x while it is. 0.1.0 is reserved for leaving alpha, not for
   the next batch of fixes, however large.

   `kind` is the size of the step as a PLAYER would feel it: `major`
   when the game changed shape (the launch, a release that changes how
   runs, maps or the screen behave everywhere), `minor` for a batch of
   fixes and features inside the shape they already know. It is not
   semver's major / minor; the version number carries that.

   HOW TO WRITE A NOTE.
   - For players: what they will notice, in plain words. "Runs on
     bhop_ananas are no longer rejected", not the cause in the engine.
   - Name maps by their map name (bhop_japan), settings by the path a
     player clicks (Settings → Graphics → Display).
   - No internal file names, function names, tools or services.
   - NEVER DESCRIBE THE STAFF / ADMIN CONSOLE or other moderation
     tooling. The card is read in the game by anyone who clicks the
     version, and a note about a tool they cannot see is noise at best.
     Chat logging: prefer not to mention it at all; if it has to be,
     say no more than the /about FAQ already does.
   - One note per thing a player would tell a friend about. Group
     small map fixes into one note with the map names.

   Every release: bump VERSION, put a new entry at the TOP of CHANGELOG
   with the same version and the release date (YYYY-MM-DD, America/
   Chicago), and set "version" in apps/web/package.json to match.
   apps/api/test/version.test.ts pins the invariants: package.json
   agrees with VERSION, the newest entry IS the version, versions
   strictly descend, dates are real ISO dates, kinds are one of the
   two words, and VERSION stays below 0.1.0 while STAGE is alpha.
   ============================================================ */

export const VERSION = "0.0.29";

/** Release stage, printed after the number ("v0.0.4 alpha"). */
export const STAGE = "alpha";

/** "v0.0.4 alpha": the version button's label. */
export const VERSION_LABEL = `v${VERSION} ${STAGE}`;

export interface ChangelogEntry {
  /** semver, no prefix */
  version: string;
  /** YYYY-MM-DD (America/Chicago) */
  date: string;
  kind: "major" | "minor";
  title: string;
  notes: string[];
  /** Related public projects or release resources. */
  links?: { label: string; url: string }[];
}

/** Notes for the next release, unpublished until promoted into CHANGELOG. */
export const UPCOMING: ChangelogEntry = {
  version: "0.0.30",
  date: "2026-10-28",
  kind: "minor",
  title: "Next update",
  notes: [],
};

/** Newest first. */
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.0.29",
    date: "2026-10-28",
    kind: "major",
    title: "Gain like CS:S, millisecond times, 71 maps and new guns",
    links: [
      { label: "Custom skies guide", url: "https://bunnyhop.lol/custom-skies" },
      { label: "Native client on GitHub", url: "https://github.com/2x74/bunnyhop-client/releases" },
    ],
    notes: [
      "Strafe gain and !ssj now match CS:S at any refresh rate. Each tick takes the mouse movement and W/A/S/D presses made before it, instead of whatever the last frame saw, so 60 Hz and 144 Hz screens no longer lose gain. It's on by default: Settings → Mouse & view → Advanced → Timestamped input. Thanks to PonyTrap, Worldspawn and hena for the reports.",
      "Runs are timed to the millisecond, like bhoptimer: from the moment you leave the start zone to the moment you enter the end zone, measured inside the tick. Times shift by a few ms (most by +4 to +6 ms), and ties are about ten times rarer. Older records are re-timed from their replays. Gauntlets rank by the sum of your ms times, and races tied on arrival go to the lower time.",
      "New T7+ tier, shown in indigo, for the hardest maps: bhop_triumph, bhop_apricity, bhop_badges2, bhop_futile, bhop_priexaliblyat and bhop_wrath. bhop_decimus, bhop_tieroverflow and bhop_alvo2 move up to T6, and bhop_greenroom_final to T5. Clearing a T7+ map gives the Transcendent badge.",
      "Points: lower-ranked records now count for a little more toward your total, so a wide spread of good times adds up better.",
      "71 new maps. Fly and tech: bhop_fly_care, bhop_fly_hell, bhop_fly_horty, bhop_fly_syzygy, bhop_fly_xerotic, bhop_flydown, bhop_flyflex, bhop_flying_rabbits_css, bhop_fly_ninja_fix_css, bhop_platinum_lol, bhop_transitions, bhop_technologeek, bhop_technology, bhop_askowo, bhop_nalliexkaren and bhop_spution. Nine Flartstrafe maps, including bhop_flartstrafe_630s, colorline, tux, dejavu_fix, lego, simpsons, cyber, kittttty and space. Plus bhop_30m, bhop_treehouse, bhop_wristbreaker, bhop_freefall, bhop_profane, bhop_skyruins, bhop_khufu, bhop_bathhouse, bhop_waterfall, bhop_beginner_castle and many more: sort the map list by Newest. Thanks to GothQueen for the map list and peril for the fly requests.",
      "On bhop_shutdown, !setstart and restarts keep you in the start zone instead of sending you to the hub. Thanks to hena.",
      "Turn speed: set how fast Turn left and Turn right turn (Settings → Keys → Turn speed, CS:S's cl_yawspeed, 210°/s by default) and hold Fast turn (Up arrow by default, like +speed) to turn faster. Both count in ranked runs in every style that allows turn binds.",
      "!setspawn (or !ss, or 4) works anywhere you stand still: away from the start zone it makes a practice spawn to restart from.",
      "Practice from here: in the replay viewer, press P (or the chip) to take over a replay at that moment and keep playing as practice, with its speed.",
      "Replays show the runner's own bunny: their colourway, knife, finish, gloves and hat. Press V (or the Weapon chip) to show what they had in hand, with knife swings, inspects, shots and reloads. After a long wait in the spawn, the replay bar starts 2 seconds before the run. Thanks to hena.",
      "Video export has a new dialog with presets (Standard, Shorts, Editing and your own saved settings), motion blur that works in every look, 4K, 240 fps, HEVC and AV1 where your browser supports them, an edit-ready quality, and Speed, Crosshair and Weapon in hand switches. Very large exports no longer run out of memory. Thanks to oasis.",
      "New supporter cosmetics, from tyzi's asks: Space Buns and Ponytail wigs, with your own hair colour, the hood down and a ponytail that swings, plus the Half Oni Mask. New metal knife finishes: Emerald Steel, Ruby Steel, Sapphire Steel, Pearl, Chromatic and Chrome, which reflect the map in the Enhanced and Cinematic looks.",
      "Gloves and sleeves got a detail pass: real hoodie sleeves with ribbed cuffs, gloves with straps, seams and pads that tuck into the sleeve, and new Plush and Bun-E forearms. The bunny's hoodie, shoes and visor have new materials and stitching.",
      "Every gun has a reworked model and new animations: recoil that snaps and settles, slides and bolts that move, reloads that drop the old mag, shells that bounce at your feet, and wrists that no longer bend at odd angles. Each gun has its own new firing sound. Other players' guns now sit right in their hands, with recoil and reloads. None of it moves your aim.",
      "Settings → Graphics is simpler: Quality, Sky, Colour & visibility and Display up front, everything else under Advanced. Sky packs no longer squash the layout.",
      "One Sky picker in Settings → Graphics, with seven skies to download, and Add from a link for Poly Haven skies, .hdr files and now any 2:1 PNG, JPEG or WebP panorama. Drop a sky file onto Settings to add it. The new guide at bunnyhop.lol/custom-skies shows how, including turning a Source skybox into one.",
      "In the desktop app, keep skies in a folder (F10 → Client → Open skies folder) and they show up in the Sky picker as soon as you save them there. This needs the next desktop app update.",
      "Hover a time on any leaderboard (or hold it on touch) to see how the run was played: browser, desktop app or native client, average FPS, sensitivity, DPI and polling rate, turn speed, jumps, strafes, sync and how many times the replay was watched. Runs from now on also show which attempt it was and how long the player had played the map.",
      "Field of view now goes up to 120.",
      "Fixed the stutters since the Source look: shaders are now prepared while the map loads, instead of mid-run when a player joins or you first see water. Loading takes a moment longer.",
      "Show input stats reads high polling rate mice correctly (a 2 kHz mouse no longer shows 10,000 Hz), and 2 kHz mice stay on raw input. Thanks to Throw.",
      "New Mapper badge for players who made maps here. Their name on the map panel links to their profile, which lists their maps. Beat a mapper's own time on their map for the Beat the Mapper achievement. Thanks to Maharero for the idea.",
      "In public rooms, players idle for 5 minutes no longer count toward RTV and map votes, and a full room makes space by moving out whoever has been idle longest.",
      "Far fewer honest runs are held for a check.",
      "The desktop app dialog explains luna's native C++ client and links to its releases.",
    ],
  },
  {
    version: "0.0.28",
    date: "2026-10-26",
    kind: "major",
    title: "Source look, bunny avatars and custom CSS",
    links: [
      { label: "Native client v0.4.0 on GitHub", url: "https://github.com/2x74/bunnyhop-client/releases" },
      { label: "Custom CSS guide", url: "https://bunnyhop.lol/custom-css" },
    ],
    notes: [
      "Every player now has a bunny avatar on leaderboards and profiles. It starts as your bunny's colourway in a random pose.",
      "Make it yours at bunnyhop.lol/avatar, or Edit avatar in your account panel: pick a pose, framing and backdrop, and dress it in the colourway, headwear, knife, finish and gloves you own. Download or copy it as a PNG to use anywhere. Prefer your Discord picture? Switch it back on in the same place.",
      "Maps now look the way they do in CS:S. The new Source look is the default: lighting matches CS:S side by side, maps with HDR lighting get CS:S's auto exposure and bloom, and water reflects the map. Thanks to huddled for the CS:S reference renders.",
      "Water reflections cost some FPS near water. They're on with the High preset; switch them in Settings → Graphics → Water reflections.",
      "Pick a different look in Settings → Graphics → Look. Plain is the old look and the fastest. Enhanced and Cinematic are back, retuned to match the Source look, with sun shadows, light from nearby lamps, sky packs and more under Advanced. Cinematic is experimental and downloads its packs once (about 23 MB).",
      "Smoke on the bhop_arcane maps is soft smoke now, and turns on and off with the map. A sky pack you picked stays picked after a reload.",
      "Restyle the menus and the HUD with your own CSS in Settings → Custom CSS: colours, fonts, pictures and GIFs. Paste a theme someone shared or add one with Import link. The guide at bunnyhop.lol/custom-css shows how and has Slant, Source and Clean to start from, and #custom-css on our Discord has more. If a theme breaks your screen, Ctrl+Shift+V turns it off.",
      "The desktop client (v0.2.2) can load a .css file and apply it again every time you save: F10 → Client → Custom CSS.",
      "The native client, written in C++ and still in beta, got the Source look, tutorial runs that upload, and a fix for a Linux crash when loading a map or opening a profile.",
      "Native client v0.4.0 brings its menus level with the browser game: profiles, Loadout, Support, the scoreboard, leaderboards and chat. It also adds replays with clip export and music, announcer sounds, character and knife animations, colour blind palettes, controller menu navigation, better high polling rate mouse handling, and the wall and ladder fixes below. Download it from GitHub.",
      "Replays and ghosts show the runner's account name. Runs from the native client used to say native-player.",
      "Black walls on bhop_unreal_space and other maps are visible again, so you no longer see through them or collide with invisible walls.",
      "The ladder sections on bhop_synthetic_fix now work. Existing replays keep their original movement. Thanks to GothQueen for both reports.",
    ],
  },
  {
  version: "0.0.27",
  date: "2026-10-25",
  kind: "minor",
  title: "RNGFix slopes, practice like CS:S and HUD scale",
  notes: [
    "Slopes work like on RNGFix servers. Jumping into an uphill slope used to lose your speed at random, depending on where in the tick you met it. Now you always land and launch off it, on bhop_null_fix, bhop_letour, bhop_lego2 and every other map. Downhill boosts also count a booster or conveyor pushing you. Thanks to GothQueen for the side-by-side video.",
    "Also from RNGFix: landing on the very edge of a block always lets you jump, thin boosters and teleports always trigger when you land on them, and a teleport on the same tick you hit a wall or land keeps your speed. Older replays keep their original physics.",
    "Checkpoints and noclip now work in any solo run, like on CS:S servers. Type !cp for the checkpoint menu. A teleport or noclip turns the run into practice: the timer turns yellow and keeps going, and a restart gives you a real run again.",
    "During a timed run, the teleport and noclip keys only work while the !cp menu is open, so a stray key can't cost you a run. Saving a checkpoint always works and never affects the run. !save saves one from chat.",
    "A small yellow Practice shows under the crosshair whenever your run won't count. Turn it off in Settings → HUD → Show on screen, or move it with Edit layout (F2).",
    "HUD scale in Settings → HUD now goes from 50% to 175%, and the whole HUD grows together instead of piling up in the middle. The F2 layout editor has the same slider.",
    "Report a player from their profile (⋯ → Report), from the replay viewer, or with !report in chat. Pick Cheating or Chat or name and add a note if you want. Your Inbox says Closed once staff have looked at it.",
    "Post a bunnyhop.lol replay link in #general, #clips or #supporters on Discord and the bot replies with a video of the run. Runs up to a minute render on their own. For runs up to 5 minutes, the bot offers an Export video button to whoever posted the link.",
    "New Contributor badge, a teal wrench, for players who help build the game. The owner's badge is now a crown.",
    "Sharing a bunnyhop.lol link shows a new preview picture.",
  ],
  },
  {
  version: "0.0.26",
  date: "2026-10-24",
  kind: "minor",
  title: "Strafe trainer styles, map groups and your Discord ideas",
  notes: [
    "The strafe trainer has two new looks next to Classic: Detailed, a coloured bar, and Minimal, a thin line with a marker. Pick Beginner, Standard or Strict in Settings → HUD → Strafe trainer, or set its smoothing, on-pace zone, height and dimming yourself.",
    "Strafe trainer: Follow the turn puts 100% in the middle and moves the marker the way you're turning. An optional jump sound tells you how each jump went by its pitch.",
    "Make your own map groups with the Groups button next to the star on any map. They appear after Favorites in the map list and follow your account. Only you see them.",
    "Play a group or your Favorites in order: choose Play in order from the Groups menu and each finish loads the next map.",
    "The dice button in the map list picks a random map from the ones it's showing.",
    "The map list's set menu shows how many maps of each tier you've finished.",
    "Newest in the map list now sorts by when a map came to bunnyhop.lol, and the map panel shows that date. Opening the map list in game keeps the map you're on in the middle.",
    "The map panel and the finish card show your attempts and time played on that map. They're counted on this device.",
    "Setting profiles: save your setup at the top of Settings and switch between profiles in one click. Your mouse, graphics and sound settings stay as they are.",
    "New Colour blind option in Settings → HUD → Colours, for red-green and blue-yellow colour blindness.",
    "A spectator list on the left of the screen shows who is watching you, like in CS:S. Turn it off in Settings → HUD → Show on screen.",
    "Spectate a friend straight from the Friends list with the eye button.",
    "Country flags show on the Tab scoreboard. Pick yours in Settings → Account → Profile flag.",
    "The timer turns yellow while practice mode is on.",
    "Optional Leaderboard place in Settings → HUD → Show on screen shows the place your current time would take, and your top %.",
    "Auto restart under Keys → Run restarts your run, or just plays a sound, once your time passes your PB, the world record or your custom ghost.",
    "B and F4 now go back to the main track after the last bonus.",
    "Reset a single key to its default with the arrow next to it in Settings → Keys.",
    "Show triggers has new options in Settings → HUD → Advanced → Triggers and clips: a colour for each kind, fill opacity, a Filled, Outline or Bottom style, and line thickness.",
    "Video export has a Quality choice, and the default is sharper than before.",
    "Think a map's tier is wrong? Choose Wrong map tier in the feedback form and pick the tier you'd give it.",
    "A dropped connection or a reload during a gauntlet no longer costs you the attempt, as long as you're back within 10 minutes.",
    "Requested maps: bhop_synthetic_fix (T4), bhop_angst, bhop_rgbglow, bhop_furret, bhop_wonderland and bhop_unreal_space (T3), bhop_dipl, bhop_mirrorsedge_chpt1, bhop_distraction and bhop_aamu (T2), and bhop_dream (T1).",
    "Thanks to everyone who posted ideas in Discord, and to ayaro for the long list.",
  ],
  },
  {
  version: "0.0.25",
  date: "2026-10-21",
  kind: "minor",
  title: "Weekly gauntlets, a longjump card and a music player",
  notes: [
    "A new weekly gauntlet starts every Monday with three maps, and now and then a harder week of four. Past weeks and their winners stay on the Gauntlets page.",
    "Permanent gauntlets are always open: the Bunny Hop Map Gauntlet (the classic 20), Insane, Lego, X Y Z, Badges, Gotta Go Fast and more.",
    "Watch a whole gauntlet run from start to finish in the replay viewer.",
    "Clearing gauntlets earns new name marks and achievements. Finish the classic 20 for the Gauntlet Champion title.",
    "Profiles show your gauntlet times and weekly wins.",
    "Longjump stats have a new two-line readout coloured by distance. The Last jump card is now an image worth posting, with your jump's arc and strafes.",
    "New Null binds option under Keys: hold A and D together and the last key you pressed wins. It is off by default.",
    "The menus play every music track in rotation, with a small now-playing control and media key support.",
    "Wind sound is now off by default.",
    "Replays opened from a link have sound again. If your browser blocks autoplay, it starts on your first click.",
    "New players get a short intro that asks if they've bhopped before, and the easy starting map changes each day.",
    "Profiles have their own shareable link, and show replay views and the records that give you the most points.",
    "In Friends you can hide a follower you don't follow back, or drop a one-way follow.",
    "A Desktop app link on the home screen shows the latest version and downloads.",
    "Leaderboards show 20 players per page.",
    "The online chart on the Stats page reaches the present again.",
    "Esc now closes the Last jump and Paint dialogs instead of opening the pause menu.",
    "Settings are tidier: options that depend on a switch only appear when it is on.",
    "New maps by Zyper: bhop_xyz (X, Y and Z in one course), bhop_xyz_v2 and bhop_zyper.",
    "bhop_arcane_v2's bonus start and end were swapped, so bonus times were reset. Main times are unchanged.",
    "New colourways, gloves, knife finishes and trails to earn by playing: map counts, tier clears, hours played, races and more. The Loadout shows what unlocks each one.",
    "Achievements now give XP, and you've been paid for the ones you already have.",
    "Eazy Money is now bhop_eazy under 60 seconds.",
    "100 new maps, from popular classics like bhop_shades, bhop_temple and bhop_island_final to recent releases like bhop_brutality and bhop_flartstrafe_cubez. Find them under New maps in the map browser.",
  ],
  },
  {
    version: "0.0.24",
    date: "2026-10-21",
    kind: "minor",
    title: "Ghost routes, paint and movement tools",
    notes: [
      "Learn a ghost's route in Settings → Ghosts & players → Route guide. Connect its jumps with straight lines and white takeoff boxes, or show its full recorded path. Follow your PB, the WR or a custom ghost you chose to race.",
      "Paint private marks on the surfaces you look at. Choose from 14 colours and three sizes in Settings → Paint, then bind hold-to-paint, a single mark or clear paint under Keys → Paint. Only you see your marks. Chat shortcuts include !paint and !clearpaint.",
      "Bind actions to Mouse4, Mouse5 and extra mouse buttons in Settings → Keys.",
      "Turn left (+left) and Turn right (+right) are now under Keys → Movement and work in ranked runs except Legit Scroll. Hold a bind to turn at 210° per second while keeping mouse aim. Both together cancel; practice allows them in every style.",
      "New optional Strafe offsets and First jump tick displays in Settings → HUD. See whether your strafe key was early or late, and the tick of your first jump from the start. Chat shortcuts: !offsets and !fjt.",
      "Measure gaps with !measure or a bind under Keys → Tools. Aim at two surfaces to see their distance, horizontal gap and height difference. Your markers are private; !clearmeasure removes them.",
      "Optional Longjump stats in Settings → HUD show distance, pre-speed, maximum speed, strafes and sync for clean jumps on flat ground. Standing longjumps and bhops are labelled separately. Toggle with !lj.",
      "Share your last jump with !ljlast: copy its summary or save an image to post in Discord. For longjump voice feedback, turn on the announcer and Longjump voice under Audio → Advanced → Announcer, and choose the minimum distance.",
      "Brightness, gamma, vibrance and Fullbright are in Settings → Graphics → Colour & visibility. Fullbright brightens world lighting while keeping textures, including in Potato mode. Your choices are saved and leave HUD colours alone.",
      "Also added since the last update: Maxwell, a spinning cat hat for supporters that reacts as you hop.",
      "Native preview: this update is for the browser and Electron client. The native preview will keep new runs locally until its next compatible update.",
    ],
  },
  {
  version: "0.0.23",
  date: "2026-10-20",
  kind: "minor",
  title: "Gauntlets, your PBs everywhere, and community requests",
  notes: [
    "Gauntlets: play a series of maps in order, compare your splits, and compete for the fastest total time. You can return to an unfinished attempt while it is still open.",
    "Your verified personal bests now follow your account between browsers and devices. Map completion marks and PB times refresh when you sign in, and your PB ghost loads when you need it. Local and offline times stay on your device.",
    "Set a separate vertical mouse sensitivity in Settings → Mouse & view. Turn it on to adjust up/down movement independently; leave it off to keep your current sensitivity.",
    "New optional Start Pre display in Settings → HUD → Jump stats. See your takeoff speed from the start zone, independently of your SSJ display.",
    "Fixed Sweep progress counting maps outside the ranked pool. Achievements you have already earned stay unlocked.",
    "Requested maps: bhop_newdun (T2, with a bonus), bhop_another20secstrafemap (T1), and bkz_goldbhop_v2 (T1). The existing bhop_bkz_goldbhop stays available too.",
    "Also included since the last numbered update: original maps bhop_lol_aero and bhop_lol_plaza, bhop_y and bhop_z, and 13 Halloween maps with a Halloween collection in the map browser.",
    "Map fixes: bhop_lol_aero's falls return you to the right section, with fixes to its lift and lilypads. bhop_lol_plaza's food-court tables are easier to reach, and its umbrellas bounce you onward.",
    "New supporter cosmetics: Plush Bunny and Bun-E models, matching Plush Paws and Bun-E Hands gloves, and a Capybara hat that reacts as you hop. Hats and rank crowns now fit the new models properly.",
    "Joining multiplayer sessions is smoother, with less freezing as other players appear.",
    "Replay controls have more room, and the HUD and whispers no longer overlap them.",
    "The feedback form has clearer categories, keeps your draft, and has a new animated bunny. Fixed overlapping hover details and an unwanted scrollbar.",
    "A new sticker-style bunny mascot appears throughout the menus.",
  ],
},
  {
  version: "0.0.22",
  date: "2026-10-15",
  kind: "major",
  title: "A new look, and much faster on slow PCs",
  notes: [
    "Every screen has a new look. Sharper buttons, a white dot that hops to whatever you point at, screens that drop in instead of sliding, and no more blurred glass behind menus, which also saves frames.",
    "The home screen has six maps to try with their world records, and Support, Discord and your Inbox are real buttons at the bottom.",
    "Pick any map and the camera flies in: the map's picture shows while it loads, then the camera swoops down to your spawn. Getting into a map is quicker too.",
    "Finishing a run: your time stays big in the middle of the screen, and your rank, points and XP sit in a small card under it. On a PB your old time in the top right gets crossed out. Beat the world record and your time turns gold while it's checked.",
    "Splits now show next to your timer. After each jump a small number shows the speed you gained or lost (Settings → HUD → Gain ticks). For more speed feel, turn on Settings → HUD → Edge glow.",
    "Start and end zones are light curtains instead of green boxes, and leaving the start lights up your timer. Races start with a big 3, 2, 1, GO.",
    "Small messages like Copied now appear where you clicked, errors look like errors, and rare unlocks and new ranks get the whole screen.",
    "Your first visit: your bunny drops in, bhops while you type your name, shows off the colour you pick and jumps at the camera when you hop in.",
    "Settings: sliders have ticks and a mark at the default (double-click to reset). Hold the field of view or a crosshair slider to see the game behind it. Pause → On screen is now a picture of your HUD: click the parts you want.",
    "Loadout: items stand on a floor in their rarity's colour and pop when you equip them.",
    "Profiles show followers, following and friends under the card. Click a count to see who. The button reads Follow, Follow back or Friends, and Block and Report are in the ⋯ menu. Ranks are sorted by points.",
    "Friends: following someone back now confirms it, every name opens that player's profile, and Unfollow has an Undo. Fixed searching for a second player after following the first.",
    "The Support page shows all three supporter cards with your name on them. Flip between Geode, High Roller and Borealis and your bunny changes with them.",
    "Leaving in the middle of a run: hold your Main menu key.",
    "Menu sounds are made from the game's own footsteps, jumps and landings.",
    "The game runs much faster on school, office and older PCs. Maps with lots of detail draw only what's in front of you, which more than doubles the frame rate on some of them.",
    "Graphics presets in Settings → Graphics → Preset: Lowest, Low, Medium and High.",
    "If your browser is drawing the game without your graphics card (common on school PCs), the game now notices, starts you on Lowest and tells you how to turn hardware acceleration on.",
    "If the game runs very slowly, it switches to Low by itself and gives you an Undo. Later it suggests Lowest if that's still not enough.",
    "4:3 stretched like CS: Settings → Graphics → Aspect ratio (4:3, 5:4, 16:10 or 16:9), stretched to fill your screen or with black bars.",
    "Resolution goes from 25% to 200%, and Sharp pixels keeps a low resolution crisp instead of blurry.",
    "Antialiasing has its own switch. Turning it off is one of the biggest FPS gains on laptops.",
    "Fixed: the timer turning green on slower runs, a red 0 on the speed after a restart, the practice tag covering your split, and the map list's last row being covered.",
  ],
},
  {
  version: "0.0.21",
  date: "2026-10-14",
  kind: "minor",
  title: "Friends, leaderboards and a clip campaign",
  notes: [
    "Friends: follow players from their profile, and when you follow each other you're friends. Friends at the bottom right of the menus shows who's online and where they are (a map, a server or a lobby), and lets you message them, invite them to your lobby, send them a map or a run, or race their PB. You can appear offline.",
    "The bell next to Friends collects new followers, invites, asks to join and friends beating your times. Nothing pops up while your timer is running.",
    "Map leaderboards have All and Following. Chat commands: !msg, !reply, !invite, !send, !follow, !unfollow and !friends.",
    "Stats is easier to read: Your stats puts your numbers, the last 30 days, styles, recent personal bests and most played maps on one page, and Game stats shows who's online over the last 24 hours (hover for any minute). The page now scrolls on smaller screens.",
    "New leaderboards in Stats → Game stats: world records, hardest clears, maps cleared, finishes, time played, most watched and top gifters. Hardest clears ranks the highest tier you have cleared, then how many maps of it, then who got there first. Open See all to search for a player or jump to your own place.",
    "The Support page is tidier. Gifting has your gift credits, the Gift Supporter button and Support again in one place, and Player glow sits beside the preview it changes.",
    "Gifting is quicker: pick who gets it, set how many with − and +, then send. Supporters are skipped and you only see a cost when the gift can go through.",
    "Gold Gifter badges now shine and Prism badges flow through their colours, on name tags in game too.",
    "Badges after your name are Verified, Creator, Server Booster, Supporter and your Gifter badge. Achievements stay on your profile.",
    "Supporters can see their glow on their own hands and knife in first person, with its own switch (In first person in the glow settings, or Settings → Ghosts & players → First-person glow).",
    "Supporters' player glow now starts on. If you turned it off or changed it, your choice is kept. The glow and aura switches are now on/off toggles.",
    "Clip campaign: make a video or stream of the game until November 1 and post it in #clip-campaign on our Discord (discord.gg/bhoplol) to get the new Clipper badge. The most viewed creator on each of YouTube, TikTok, X and Twitch gets a gold Creator badge.",
    "Links to bunnyhop.lol and our Discord are clickable in inbox letters.",
    "Other players in a server move more smoothly: their jumps and strafe turns follow curves between updates instead of straight lines.",
    "Landing on downhill ramps keeps your speed consistently. Older replays keep their original physics.",
  ],
},
  {
  version: "0.0.20",
  date: "2026-10-13",
  kind: "minor",
  title: "Stats, gifting and player glow",
  notes: [
    "Stats on the home screen has Your stats and Game stats tabs: progression, activity and personal bests alongside players online, recorded peaks, maps, verified finishes, jumps and time playing. Profiles show activity, style progress and the maps you play most.",
    "Replay views: hover or focus Watch to see how many times a run has been watched. Profiles show their received views, and Stats has a searchable most watched runners leaderboard. Views start counting with this update.",
    "The style description in Choose a map now has its own row, so switching to Low Gravity no longer shifts the map list and preview.",
    "Fixed the invisible door blocking bhop_ln_portal by honoring doors that start open. Older replays keep their original physics.",
    "Hidden trigger-brush surfaces on kz_bhop_kantan during normal play; Show triggers still works. Restored normal-map surface detail on kz_bhop_solitude's pale concrete and tiles.",
    "Removed the stray sound after the Perfect announcer line.",
    "Corrected six kz bhop difficulty ratings: kz_bhop_badg3s is now T5; kz_bhop_global and kz_bhop_minimal are T4; kz_bhop_learning, kz_bhop_peaceful and kz_bhop_proxy_null are T3. Existing finishes will receive points for the corrected tiers.",
    "Share permanent Supporter perks: every full $5 after your first $5 earns a gift credit, including past donations. Gift a player, your server, or random players across the game, online or offline.",
    "Supporters can enable their own player glow in Profile → Loadout or on the Support page; it starts off. Pick a preset or custom hex colour, adjust intensity, and add an animated aura. Seeing other players’ enabled glows starts on and can be turned off in Settings.",
    "Server gifts celebrate in chat with a new gift sound. Linked accounts get priority for random gifts, with better odds for regular players; guests can receive gifts too.",
    "Earn Bronze, Silver, Gold and Prism Gifter badges at 1, 5, 25 and 100 gifts. Gold shines; Prism lets you choose its colours and animation.",
    "Choose and arrange up to three badges beside your name in Edit card. Staff badges use one of the three slots; your full achievement collection stays on your profile.",
    "Export vertical 9:16 replay videos for TikTok and YouTube Shorts. The Shorts preset starts with the action, with readable portrait overlays, optional captions, custom clip start/end times and a branded leaderboard ending with your place and points.",
  ],
},
  {
  version: "0.0.19",
  date: "2026-10-12",
  kind: "minor",
  title: "129 maps, announcer sounds and the desktop client",
  links: [{ label: "Bunnyhop desktop client on GitHub", url: "https://github.com/8tp/bunnyhop-client" }],
  notes: [
    "129 new ranked and tiered maps, including bhop_cw, bhop_shutdown, bhop_sky, bhop_quake_final, bhop_egypt and bhop_leaf. The map browser now has 471 maps to explore.",
    "Scroll jumps register correctly when standing up from crouch just above the ground. Existing replays keep their original movement rules.",
    "Desktop client support: optional Discord activity with map artwork, local run history and PB screenshots, and client settings from the game. Loaded maps and shared assets stay cached on disk across restarts. The client is a development preview; source and setup instructions are on GitHub.",
    "Perfect, Godlike and Holy shit announcer sounds: enable them in Settings → Audio, then choose lines for personal bests, world records, speed milestones and perfect-hop streaks. Adjust the volume and thresholds, or turn individual triggers off. Hearing other players' world-record calls has its own switch.",
    "Live Perf% and optional Perfect hop feedback for Legit Scroll and EZ Scroll, including replay viewing and exported clips. Classic movement sounds give a clearer landing cue when you hop immediately.",
    "Loadout → Clear all indicators dismisses every new-item dot in Loadout at once. They stay cleared on this device; newly unlocked items still get their dots.",
    "Save progress is now Sign in. Use the same Discord account or email to access your existing runs, name and unlocks when switching browsers or devices.",
    "F4 cycles bonus tracks alongside B. Existing custom bindings are preserved; change the shortcut in Settings → Keys.",
    "Low Gravity: hold jump with half the usual gravity. It has separate leaderboards and style rankings, without overall points, XP or clear achievements. Bonus tracks still use Normal movement.",
    "Movement and attack input now clear when the browser loses focus, preventing missed key releases from leaving a key held when you return.",
    "Press L for a flashlight in dark sections, including Potato mode. Rebind it in Settings → Keys or toggle it in Settings → Graphics. It starts off when you enter a map.",
    "Fixed water fog hiding the platforms in bhop_sonni_v2's descending water section.",
  ],
},
  {
    version: "0.0.18",
    date: "2026-10-11",
    kind: "minor",
    title: "Legit Scroll, a strafe trainer and profile flags",
    notes: [
      "The old Legit Scroll is now EZ Scroll. Its movement and records stay the same. A new Legit Scroll style has its own leaderboards, with 250 run speed, 100 air acceleration and CS:S stamina. Prehopping in the start zone is blocked, following shavit's default settings.",
      "Legit Scroll has two new achievements: True Scroll for your first clear, and Legit Scroller for clearing 10 different maps, with a matching title. Stylist now includes Legit Scroll; if you've already earned it, you keep it.",
      "Strafe trainer: a thin, transparent gauge to help you find the right turning pace while strafing. Turn it on in Settings → HUD, or type !st or !strafetrainer. Pick your own colour, turn on text hints if you want them, and move or resize it in Edit layout. It starts near the upper centre of the screen.",
      "Map leaderboards now show strafes beside jumps. Legit Scroll also shows Perf%, the percentage of your hops that landed a perfect jump.",
      "Profile → Profile flag: add an optional country flag before your name on leaderboards and on your player card. Use the detected country when available, or pick your own. You can change or remove it anytime. Setting a flag earns Flying the Flag.",
      "Profiles now show in-game sensitivity, optional DPI and eDPI. Sensitivity follows your game setting; enter your mouse's DPI in Profile → Mouse settings or Settings → Mouse & view. Leave DPI blank if you don't know it.",
      "Supporters get a spinning Propeller Cap. Find it in Loadout → Hat.",
      "Choose Model A or Model B in Loadout → Colourway. Both bunny builds are free, and your choice carries into multiplayer, ghosts and replays.",
      "Fixed Style Champion so it checks your current style rankings when you equip the title and updates when you lose the qualifying rank.",
      "Style selectors wrap to fit the extra mode, and map leaderboards make room for the new stats and flags on smaller screens.",
    ],
  },
  {
    version: "0.0.17",
    date: "2026-10-11",
    kind: "minor",
    title: "Steadier mouse input and an FPS limit",
    notes: [
      "Raw input stays raw: if your browser turns it down for a moment (right after Esc, for example), the game asks again on your next click instead of quietly switching to your system's mouse acceleration, which could make your sensitivity feel different from one moment to the next.",
      "On Linux, browsers can't give raw input, so your desktop's mouse settings apply: set pointer acceleration to flat (none) for the same feel as in CS.",
      "Settings → Graphics → Frame rate: an FPS limit (1000 by default) and Exceed monitor FPS, to draw more frames than your screen refreshes. Under Advanced: Low-latency canvas, which those extra frames need to reach the screen, and an FPS limit for menus.",
      "Show input stats now says why raw input was turned down, if it was.",
    ],
  },
  {
    version: "0.0.16",
    date: "2026-10-11",
    kind: "minor",
    title: "Private lobbies and !race",
    notes: [
      "Private lobbies: your own server for you and your friends. Play online → Create private lobby (sign in with Discord or email first), then send the invite link from Esc → Server → Copy invite link, or type !invite. Friends can join as guests.",
      "Lobbies hold up to 8 players and can play any map, unranked and kz maps included. The host changes the map (!map, or Esc → Server → Change lobby map), starts a vote, extends the time and can kick or mute. Runs count on the leaderboards as usual, and a lobby closes 15 minutes after everyone has left.",
      "!race: challenge someone in your server or lobby to a race on the current map, in any style, on the main track or a bonus. Type !race on its own (or Esc → Server → Race a player) to pick from a menu. You both start together after a countdown, and race runs count on the leaderboards. !race off stops challenges reaching you.",
      "Supporters can support again from the Support page. Every payment adds to your total on Top supporters.",
      "kz_bhop_essence no longer freezes at the long jump.",
      "bhop_strafe_winter is now Tier 2.",
    ],
  },
  {
    version: "0.0.15",
    date: "2026-10-10",
    kind: "minor",
    title: "Supporting opens, favorite maps and !showtriggers",
    notes: [
      "Supporting bunnyhop.lol is open: a one-time payment of $5 or more, any amount you like, from Support at the bottom of the main menu. It unlocks all three supporter sets and both supporter knives, a heart next to your name, a name colour and effect, a spot in a full server and a place in Top supporters. Sign in with Discord or email first so it stays with your account. The game stays free, and nothing you can buy helps you play.",
      "The Support page fits on one screen: every supporter item is on the right, grouped by set, to try on, and Top supporters has its own tab.",
      "Favorite maps: star a map by its name in the map list or beside Play, then switch All maps to Favorites to see just those. Your stars follow your account to any device.",
      "!showtriggers and !showclips show a map's teleports, boosters and other triggers, and its player clips and invisible walls; !triggers picks which kinds. Runs with them on count as usual.",
      "Your USP's silencer stays as it was when you restart, and your gun is already in your hand, ready to shoot.",
      "Chat shows your cursor: press Y (or U) and you can scroll back through the chat with the mouse wheel while you type. The game keeps going underneath, and Enter, Esc or a click on the game puts you straight back in.",
      "No more \"too many submissions\": grind a short map as much as you like, every finish counts.",
      "#1 on the Auto-strafe rank now earns the Style Champion title, like #1 in any other style. Auto-strafe keeps its own leaderboards and rank.",
      "New players get Learn to bhop right on the main menu for their first two days, until they finish it.",
    ],
  },
  {
    version: "0.0.14",
    date: "2026-10-09",
    kind: "minor",
    title: "64 new maps, the Hermes map and supporter sets",
    notes: [
      "63 new maps. 49 are the maps people clear most on the big CS:GO servers, in their CS:S versions; 14 come straight from CS:GO (bhop_easystrafe_1, borders, sp_v3, noodles_v2, topbhop_v1, mixempire and more); and kz_bhop_essence, which you asked for in Discord. Short ones to start with: bhop_3_easy, bhop_xcsource, bhop_royal, bhop_coal_mines_css and bhop_passionlessly. For a longer run, try bhop_reportal or bhop_nup2_css.",
      "bhop_lol_hermes, a new original map: a T3 run of two minutes or more through seven themed sections, with launch pads, spinning gears and a surf slide, up to a city in the clouds.",
      "Staff badges: a small shield next to the name of moderators (green), admins (blue) and the developer (gold), on the leaderboards, profiles, in chat and above players in servers, so you can always tell who's staff.",
      "Your !usp or !glock stays with you when you restart.",
      "Supporting bunnyhop.lol opens soon: a one-time payment of $5 or more, for three thank-you sets of cosmetics. The game stays free. Support, at the bottom of the main menu, lets you try them all on now.",
      "Three supporter sets: Geode (four gems orbiting your head, a crystal halo, a circlet and three animated finishes), High Roller (a dealer's visor, lucky coins, a gold-leaf finish) and Borealis (an aurora ribbon and an aurora finish), each with its colourway, gloves, trail, ghost colour, card frame and background. Supporters also get a badge next to their name, a name colour and effect (glow, gradient or shine), a spot in a full server, and a place in Top supporters and on the About page they can opt out of.",
      "Two supporter knives: the Thornback, a big sawback bayonet you toss and catch, and the Thistle, a slim bayonet that spins round your finger.",
      "Main menu is back at the bottom of the pause menu, in red so it's easy to find; Backspace also takes you there, and you can bind a key for it in Settings, Keys to leave straight from the game.",
      "Something out there has wings.",
      "bhop_tesquo_v2's neon boosters work: stand on a booster platform, shoot it with the Glock the stage gives you and jump to fly up. Shots and knife hits now reach physics boxes like in CS:S.",
    ],
  },
  {
    version: "0.0.13",
    date: "2026-10-08",
    kind: "minor",
    title: "Potato mode, six new songs and a pause menu that fits",
    notes: [
      "bhop_2easy's teleports to the next stage now cover the back of each end room, wall to wall, so you can't jump over them or walk past them any more, and the blue trails that mark them in CS:S spin around them again (other maps' spinning trails show up too).",
      "Maps lit by named or flickering lights aren't dark anymore: bhop_cutekittenz past its start room, kz_bhop_indiana's tunnels, bhop_legenda_v2, bhop_catalyst_fix and a few others are now lit like in CS:S.",
      "Fixed the view sometimes snapping to the floor or somewhere else in Chrome, Edge and Opera on Windows: the mouse filter now catches the browser's fake jumps when they come in pairs or during fast strafes, and real flicks still go through.",
      "Auto-strafe: hold A or D in the air to strafe yourself (for surf ramps), and W now moves you forward in the air while the game keeps strafing for you.",
      "Potato mode in Settings, Graphics: flat colours like dev textures, plain water and sky, for laptops and slow GPUs. Maps with a lot of water (arcane, advi_new, crash_egypt, bkz_goldbhop) also run faster for everyone, with no change in how they look.",
      "Six new songs in the in-game playlist (P skips to the next one).",
      "The pause menu fits on laptop screens without scrolling: Main menu is a button at the top, and Leaderboard, Style, Replays, On screen and Help are tabs above the panel on the right.",
      "The profile's Collection tab is gone: your items are in Loadout and Edit card, and Edit card, Badges now also lists the achievements you haven't earned yet, with your progress.",
      "Profile and Loadout in the menus no longer show new-unlock hints, and your profile no longer opens with a \"Since your last visit\" card. Unlocks still get their card when they happen, and new items keep a dot until you look at them.",
    ],
  },
  {
    version: "0.0.12",
    date: "2026-10-08",
    kind: "minor",
    title: "Weapon commands, the USP silencer, solo chat and !ssj",
    notes: [
      "Chat commands work in single player too: press Y and type !r, !b, !setstart, !clearstart and the rest, like in online servers. !help lists them, and the up arrow brings back what you typed before (in servers too).",
      "Weapon commands like on bhop servers: !usp, !glock and !knife (or 5 and 6) replace the gun in that slot and draw it. !gun <name> or !guns (7) gets any of our guns in practice mode and on unranked maps; ranked runs stick to the USP, Glock and knife.",
      "The USP has its silencer: right-click screws it on or off, which takes about 3 seconds like in CS:S. It's quieter with it on, and other players in your server see it.",
      "Right-click now does what Mouse 2 is bound to (the knife's stab, the silencer). Until now the middle button did. If you bound right-click or the middle button to something yourself, it stays on the same button.",
      "bhop_monster_jam's buttons break their walls again, so the main track can be finished, and bhop_hive's breakable walls work the same way. Walls that break, switch off or get removed now disappear from view too, and come back when the map brings them back.",
      "A better !help: a few short lines with your own keys, !help practice (or styles, bhop, keys) explains one thing, and the pause menu has a Help tab. The names you know from bhop servers work too (!noclip, !cp, !tele, !n, !sw, !hsw, !wr, !pb), and a mistyped command suggests the closest one.",
      "!ssj: your speed, gain, sync and strafes on the 6th jump (or every jump, or every 6th) as a line in chat, counted the way bhop servers' SSJ plugin counts them. Type !ssj or go to Settings, HUD, Jump stats to turn it on and pick what it shows; the Jump stats element puts the same numbers on your HUD and in replays.",
      "New players start a map looking at it, with one line: click to start. Esc still opens the menu. The tutorial's ending plays one thing at a time now, and the bunny no longer covers the words.",
      "Finishing the intro is saved properly: some players were shown it again on another device.",
      "The first-visit intro is shorter: the strafing drill is gone, and the tutorial teaches it in the map instead.",
    ],
  },
  {
    version: "0.0.11",
    date: "2026-10-07",
    kind: "minor",
    title: "Start points, hide UI, guns in servers and Discord feeds",
    notes: [
      "Hide UI for recording clips: press F1 in game, while spectating or in a replay and only the game is left, with your speed and keys if you want them (Settings, HUD, Hide UI). In game it stays hidden until you press F1 again; Esc still opens the pause menu. In replays it's also a button next to HUD, and Esc brings the controls back.",
      "Start points: stand still anywhere in a start zone and press 4 (or type !setstart in a server), and restarts put you on that spot, facing the way you were. Clear start point (!clearstart) goes back to the usual spot. Each map and bonus keeps its own, and runs from them count like any other.",
      "Boosting the bunnyhop.lol Discord server puts a pink gem next to your name on the leaderboards, your profile and in online rooms. Link Discord to your account and it shows up on its own; it goes away when the boost ends. Edit card, Badges has a switch to hide it.",
      "Items you own say how you got them in the Loadout, the Collection and Edit card, with the date and the map when a run earned them.",
      "In online rooms you now see the gun other players are holding, and hear and see their shots.",
      "Guns sit lower and further out on the right, the left hand holds the rifles and shotguns from underneath instead of a big sleeve coming up the middle of the screen, and the bottom-right corner shows the rounds left in the clip instead of the gun's name (Ammo in the HUD layout).",
      "The boost pads on bhop_badges and bhop_badges_mini work like in CS:S: the first shot at a pad boosts you, and the Glock's burst fires once per click.",
      "If your account is linked to Discord and you're in the bunnyhop.lol server, ┃levels posts a card with your avatar and frame when you reach level 5, 10, 20, 30 or 50, clear your first T4, T5 or T6 map, or finish 100 maps.",
      "Snipes: when someone takes your world record and you're in the Discord server, ┃snipes posts it with the replay and pings you. /snipes or the button in ┃roles turns the pings off.",
      "Every Monday the Discord server names a Player of the Week: whoever set the most world records that week that still stand. They get the Player of the Week role until the next one.",
      "┃servers in the Discord server shows who's playing in each online server, with a Join button.",
    ],
  },
  {
    version: "0.0.10",
    date: "2026-10-07",
    kind: "minor",
    title: "77 new maps, a new map list, practice mode and guns",
    notes: [
      "77 new maps, 34 of them T1 or T2. For getting started there's bhop_atom, bhop_lm, bhop_dom, bhop_kitum, bhop_zentic, bhop_emevaelx3 and bhop_blue_shade_fix; for later, bhop_colour, bhop_dragon_fix, bhop_enigma, bhop_hangtime2_fix and bhop_futile.",
      "Play has a new map list. Pick a map and its leaderboard is right there: the top times, the world record and your own time and rank, without loading the map. Full leaderboard opens the whole board.",
      "Styles are one switch at the top of the map list, each by its full name, with its rule beside it. The style you pick there is the one for the times in the list, the leaderboard you're looking at and the run you start.",
      "Every map in the list shows its tier, your PB, the world record, a WR mark on the records you hold, and Played on maps you haven't finished yet. Maps with bonus tracks say how many.",
      "Search, a tier filter, the map sets and six ways to sort: popular, easiest first, newest, name, not played yet and unfinished. The arrow keys move through the list, Enter plays, / jumps to the search and F3 switches style.",
      "Unranked maps say so in the list and where their leaderboard would be, instead of showing an empty board.",
      "The tutorial moved from the main menu to the top of the map list, with your lessons, your best time and the final course's leaderboard. If you don't need it, Hide tutorial takes it off the list and the pause menu (it's also in Settings, Account). Tutorial, under the main menu, always opens it.",
      "The main menu has one panel on the right now: a map to play and three to try next. Recent records and the stats tiles are gone from it, and Play online is a menu item like the others.",
      "On a phone the map list fits the screen: tap a map to see its leaderboard. You still need a computer to play.",
      "Practice mode, in the pause menu: fly through the map with noclip (Z), save checkpoints (C) and teleport back to them (X). A teleport gives you back the time and speed you had. Nothing you do in practice is submitted or saved as a PB, and leaving it puts you back at the start. It's for solo play.",
      "Turn with the arrow keys in practice mode, like +left and +right in CS:S. You can rebind them in Settings, Keys, Practice.",
      "Third person (T) is off during a timed run, so a stray press can't turn your run into practice. It works as before in the start zone, after you finish and in practice mode.",
      "Z no longer opens the zone editor. It's the noclip key in practice mode now.",
      "Guns work on the maps that hand them out. On bhop_badges and bhop_badges_mini you pick a gun up from its stand and shoot the pads to be pushed up or sideways; fire again just as each push runs out to keep climbing. 1, 2 and 3 pick a slot, Q goes back to your last weapon and G drops the gun you hold. They're in Settings, Keys, Weapons. bhop_badges and bhop_badges_mini are ranked again.",
      "Guns a map gives you are our own: the Thumper burst pistol, the Cottontail, the heavy Jackrabbit, the Broadfork pump shotgun, the Hedgerow auto shotgun, the Seed Drill, which feeds from a pea pod, the Furrow rifle and the Beanpole sniper with its sliding bolt. Each has its own sounds, recoil, reload and an inspect on F, held in your gloves, and your bunny holds it in third person.",
      "Guns lie on the floor where the map puts them and where you drop them, and replays show them too, along with the gun in your bunny's hand.",
      "bhop_2flocci2furious's stepping tiles hold you now, as they do in CS:S; before, you fell through them. A few other maps with the same kind of tile (bhop_thc_island, bhop_ivy_final and some others) get them too. Thanks to Blackmale42 for the report.",
      "Long runs save. A run can be up to 4 hours now; before, a run of about an hour was too big to upload and was lost. If a long run of yours was refused before this update and it's still your PB on that map in this browser, it's sent again the next time you open the game, and you'll get a message when it's verified.",
      "If an upload fails because of the connection or because you closed the tab, the run is kept in your browser and sent again once. The end-of-run card says so instead of only saying the leaderboard is offline.",
      "Runs are checked faster: most verdicts come a couple of seconds sooner, and the card picks them up sooner too. Long runs are checked separately, so they no longer hold up anyone else's, and the card shows how far along the check is.",
      "Player cards show how long you've played instead of time on the clock. It counts time spent playing a map, practice and online servers included, and starts from an estimate based on the runs you've uploaded. Cards also no longer say whether an account signed in with Discord or email. Guests still show as guest.",
      "Clocked In and Overtime now count the hours you play, not just time on the clock in finished runs. If you already have the hours, they unlock with your next finished run.",
      "TikTok and X creators get a creator mark too, next to the YouTube and Twitch ones.",
      "Auto-strafe: hold S in the air to stop the automatic strafing and slow down, so you can drop into small holes. Your own A and D work while you hold it.",
      "Tiers are fixed on 40 maps. kz_bhop_yonkoma and kz_bhop_indiana were listed as T1 and are T4 now, kz_bhop_benchmark is T5, and the rest moved one tier to match what most servers use. Points and ranks are worked out again with the new tiers.",
      "bhop_arcane_v2 replaces bhop_arcane_v1. It's the version most servers run: the same map without the random pushes on the ice platforms.",
      "Duplicate copies of maps are gone from the list: bhop_mp_stairs_dev, bhop_mp_stairs_hq, bhop_larena_nodoors, bhop_null, bhop_aztec_fixed, bhop_fps_max and bhop_frost_bite_v1a. Your times on them stay on your profile, but they no longer give points.",
      "Maps download in about half the size, so they load faster.",
    ],
  },
  {
    version: "0.0.9",
    date: "2026-10-07",
    kind: "minor",
    title: "A new Loadout, automatic Discord rewards and better ladders",
    notes: [
      "The Loadout has everything you wear in the game now: knife, finish, gloves, your bunny's colourway, your ghost and its trail. Hover anything to see it on your hands, your bunny or your ghost, click to put it on.",
      "Your profile card is edited on the card itself. Press Edit card under it and pick a background, frame, title, badges or links. The Customise tab is gone.",
      "Discord rewards are automatic. Link Discord and you get Blurple if you're in the bunnyhop.lol server, and the Afterglow set if you boost it. If you join later it shows up within the hour, a new boost within a few hours. No more Check membership button.",
      "You can answer our replies to your feedback. Open the reply in your Inbox and write back under it. It goes into the same conversation, so there's no need to send a new report.",
      "Your knife works on the map now: left click swings, right click stabs, like in CS:S. Hit a button that's meant to be shot and it presses. On bhop_hive, knife the keypad next to the first door and the door opens, so the map can be finished. Thanks to wik for the report.",
      "Ladders climb like in CS:S. Holding W goes straight up instead of drifting sideways off the ladder, ducking climbs slower, and you can hang still. bhop_monster_jam's narrow ladders can be climbed now. Thanks to Frosty_Leaper for the report.",
      "Water that a map raises and lowers is real water now: you can swim in it instead of falling through. On bhop_lost_world, turn the valve in the lab (press E) and the tank floods. bhop_crash_egypt's tide rises and falls again, and the pools on bh_aztec, bhop_algebradude, bhop_militia_v2, bhop_runbhopper_v2 and other maps can be swum in.",
      "Runs set before this update keep their times and replays.",
    ],
  },
  {
    version: "0.0.8",
    date: "2026-10-06",
    kind: "minor",
    title: "The Discord, fair play and a tutorial that finishes",
    notes: [
      "bunnyhop.lol has a Discord: Join the Discord is on the home screen, the About page and in What's new. You can also sign in with Discord now. In the server, linked players get roles for their level, crown and world records, pick a name colour, and can ask the bot for /leaderboard, /wr, /pb and /profile.",
      "Link Discord to your account (click your name, then Link Discord) and the Sport · Blurple gloves are yours.",
      "Join the bunnyhop.lol Discord server, then press Check membership (Profile → Customise → Colourway) for the Blurple bunny colourway. Boosting the server gets you the Afterglow set: Moto · Afterglow gloves, the Afterglow colourway and trail, and a Server booster mark on your profile while you boost. Everything you earn stays yours, even if you leave the server or stop boosting.",
      "Linked Discord? You can use your Discord avatar as your bunnyhop.lol avatar: click your name and turn on Use my Discord avatar, right under Discord. It shows on your profile and the leaderboards instead of your letter. It's off unless you turn it on, and you can turn it off any time.",
      "Played bunnyhop.lol before this update? You get the Early Hopper achievement and title. Thanks for being here early.",
      "Learn to bhop: finishing the final course now counts. Coming in from the lessons, the finish said \"practice run (third person)\" and the home screen stayed on \"3 of 4 lessons done\". Now you arrive on the course's start pad, and your time is submitted like any other run.",
      "The tutorial's final course has a leaderboard. When you finish you see the top 10, your place and the next time to beat. Leaderboard next to Learn to bhop on the home screen shows the whole board. It doesn't give rank points.",
      "When you unlock something, its card now shows a little 3D model of it instead of a flat icon: your new gloves, finish or knife turning in the light, a medal for an achievement, a nameplate for a title, a ribbon for a trail. With reduced motion turned on it stays still.",
      "Runs are now checked more closely for scripted or automated input. Runs that a person couldn't have played are rejected automatically, and others may be looked at by a moderator. If you think one of your runs was rejected by mistake, tell us through Feedback in the game.",
      "Moderators are here: they show with a Mod tag in chat, on the scoreboard and on player cards. We're looking for more: apply in the game through Feedback (pick Moderator application), and come say hi in the Discord.",
      "If a new version comes out while you have the game open, opening a menu or panel that hadn't been loaded yet no longer fails: the game reloads into the new version (never during a run), or tells you to.",
    ],
  },
  {
    version: "0.0.7",
    date: "2026-10-06",
    kind: "minor",
    title: "Fairness, creators and reliability",
    notes: [
      "When a new version of bunnyhop.lol comes out while you have the game open, a quiet note says so with a Reload button. It only shows in the menus (or tells you to press Esc right after a run), never interrupts a run, and reloading brings you back to the same map and style. A run you just finished is uploaded first.",
      "Start zones now work like bhoptimer. Your timer starts from the ground inside the start zone: walk out, jump, or drop off a ledge inside it, and a jump counts from takeoff. Flying through the zone in the air no longer starts a run, so mid-air exits at a free 290 u/s and ledge starts are gone. To reset in the zone, land and stand for a moment (or press R). Thanks to Those who So for the report.",
      "Runs set before this update keep their times and replays.",
      "Verified players now have a blue check next to their name, and YouTube and Twitch creators a small creator mark: in server chat, on the scoreboard and name tags, on leaderboards and ranks, on profiles and in profile link previews. Only bunnyhop.lol hands them out, so nobody can fake one.",
      "Put your YouTube, Twitch, X and TikTok on your profile: Profile → Customise → Links. Just your handle (or paste a link to your page); links only ever go to that site. They stay hidden until you turn on Show on my profile.",
      "The main menu fits on shorter screens (a 720p screen, or 1080p with display scaling) instead of cutting off the bottom items.",
      "Runs on the biggest maps, like bhop_miku_v2 and bhop_dimensions, now verify on the first try, and a run can no longer sit on \"waiting for verification\" for hours: anything stuck is picked up again within minutes. If a run can't be verified because of a problem on our side, the end-of-run card says so instead of calling it rejected.",
      "New to bhop? Learn to bhop is open to everyone: a short hands-on course from the home screen that teaches jumping, strafing and gaining speed, ending in a small graduation run.",
      "Runs with key presses no human can make (like switching strafe keys every single tick) are now rejected automatically, and banned players can't submit runs. Cheated records on bhop_bfur and other maps have been removed.",
    ],
  },
  {
    version: "0.0.6",
    date: "2026-10-05",
    kind: "minor",
    title: "Auto-strafe, CS-style knife holds and a calmer, juicier UI",
    notes: [
      "Auto-strafe, a new style for anyone who doesn't want to tap A and D: in the air, just move the mouse and the game presses A or D for you, whichever way you turn. W does nothing in the air (it only slows you down there). Still your aim and your timing. Pick it in the map browser or the pause menu, or press F3.",
      "Auto-strafe is its own mode: it has its own leaderboards, world records and rank, and doesn't count towards your overall rank, XP or map-clear achievements.",
      "Auto-strafe runs don't add to the lifetime runs, jumps and time that achievements count, and #1 on the Auto-strafe rank doesn't earn the Style Champion title.",
      "Steadier mouse look: the sudden flicks you never made, which some browsers send now and then with a fast mouse (1000 Hz and up, mostly when raw input is off or not supported), are filtered out, and so is the jump that could come right after you click into the game. Settings → Mouse & view → Spike filter is on by default; it only drops a single mouse report far bigger than the ones around it, which no real flick is.",
      "Settings → Mouse & view → Show input stats (or ?inputdebug=1 in the address) shows, while you play: whether you have raw input, your mouse's polling rate, every movement, any flick the filter dropped, your frame times and stutters. Screenshot it when you report flicks or freezes; feedback sent with game info attached carries the same numbers.",
      "Finishes are simpler: each one is a single design, the same for everyone. No more pattern numbers, fade percentages or Factory New; a finish's name is the whole story.",
      "A new set of ten finishes, all our own: Sunset (a warm sky gradient with clouds, at level 20), Ember Glaze (a kiln-fired glaze, for 10,000 jumps), Tiger Lily (petal orange with dark freckles, for a tier 4+ map in another style), Nebula (gas clouds and twinkling stars, your first tier 4 map), Dewdrop Web (a silver web with dew, your first tier 5), Frost (ice and frost ferns, your first tier 6), Heartbeet (a sliced beetroot, for a world record), Four-Leaf (an emerald meadow of clovers, some of them gold, at level 50), plus Garden Fresh and Founder's Gold.",
      "Nobody loses a finish: whatever you had equipped becomes its closest new look (Sunset Fade is now Sunset, Kiln Hardened is Ember Glaze, Doppelhop Phases 1, 2 and 4 and Black Pearl are Nebula, Sapphire and Phase 3 are Frost, Ruby is Heartbeet, Gamma Emerald is Four-Leaf, Bramble Web is Dewdrop Web), and anything you had earned the old way stays unlocked.",
      "Unlocks, level-ups, achievements and rank-ups each get their own moment: one card at a time at the bottom of the screen, with the reward popping in, your level counting up and confetti for the big ones. They wait until your run is over, so nothing pops up in the middle of a run.",
      "Meet the bunny: a little hooded bunny with a carrot now cheers your level-ups, shows off a rare finish, waves when you meet Huddled on a server, naps in an empty Inbox and looks sorry when a map won't load.",
      "World and server records on the servers get a banner across the top (confetti for a world record, unless you're mid-run), and so does your own world record.",
      "The end-of-run card lands with a little bounce, a new PB stamps onto it, and once your run is verified your points and XP count up and a top-10 place pops.",
      "Small messages (link copied, sound off, now playing, stage splits, errors) look the same everywhere, stack neatly instead of covering each other, show ×2 when they repeat and stay while your mouse is over them. On a phone, swipe one away.",
      "A new reply in your Inbox shows up as a message with an Open button, and the Inbox count pops when it goes up.",
      "With reduced motion turned on in your system, all of this appears without animation.",
      "The Loadout now lives in your profile: Profile → Loadout, next to Overview, Runs, Collection and Customise. The pause menu's Loadout button, Settings → Viewmodel and the Equip button on an unlock open it there directly. It's a normal page now with the knife big on the left and the items on the right, not a screen that covers everything.",
      "Smooth scrolling and hovering in the profile and the Loadout, even on laptops: the blurred map behind full-screen menus is now a still picture instead of being redrawn and re-blurred every frame.",
      "A shorter main menu that fits on every screen: Controls moved into Settings → Keys (\"How to bhop and every control\"), and Feedback and Inbox sit in one quiet row under your account.",
      "The map browser's style picker is one row, so the style, its description and Play fit on screen together, from 720p up.",
      "Long player names no longer disappear from leaderboard rows, the music's \"now playing\" note no longer covers the pause menu, and a sign-in message no longer hides behind an unlock.",
      "Calmer menus: section labels are plain sentence-case text instead of small spaced-out capitals.",
      "Knives are held the way CS holds them. The Bunnyfly idles open, blade forward like the CS butterfly knife, and its draw is the flip open (it only closes inside its inspect tricks). The Karrotbit hangs below your fist with the hook curving forward and away from you, ring on your index finger; turning it to face you is now how its inspect tricks end. Every knife idles in the same spot with or without the CS:S animations.",
      "Better grips in every glove: your fingers wrap the handle and rest on it, with no gaps and no fingers sinking through it (the Carrot Blade's handle used to sit in your fingers rather than your fist), the thumb lies over your fingers below the guard, and the Daikon-tana's guard no longer cuts through your thumb. The Bunnyfly's fingers let go for its flips, and the wrist and sleeve cuff stay together when the hand bends.",
      "A lower, smaller viewmodel by default: the knife sits low on the right and covers about as much of the screen as the CS:S knife does, with the blade in full view. If you never changed Settings → Viewmodel (FOV and offsets), you get the new look automatically; if you did, your settings are kept. Classic is the new default; Reset position goes back to it.",
      "Five quiet new sounds go with the new messages: a soft tick when an Inbox message pops up, little rising ticks as your points and XP count up, a thump when a new PB stamps onto the end card, a tiny boing when the bunny hops, and a shimmer as a new finish or gloves shine. They play on the UI channel (Settings → Audio), sit well under the game, and never play mid-run.",
      "Turn the keys overlay off (or back on) in one click: it's the first switch in Settings → HUD and in the pause menu's new On screen tab, next to switches for speed, timer, splits, sync, FPS, chat, name tags, ghosts and the viewmodel. You can also bind a key to it: Settings → Keys → Show / hide keys overlay (unbound to start with).",
      "A shorter Settings page: what most people change comes first, small groups are merged, and what few people touch sits under Advanced at the end of its section (the spike filter and input stats, the rarer HUD elements, viewmodel offsets, bob and sway, channel mutes). Search still finds every setting and opens Advanced when the match is in there. Your settings carry over as they are.",
      "Settings search knows more of the words players use (wasd, spike, flicks, loadout, viewmodel offset, hold to restart), and when nothing matches it suggests what you probably meant: Enter takes the suggestion.",
      "Name tags over other players on a server can be turned off: Settings → Ghost → Player tags.",
      "Fewer things blinking for attention: the \"new\" dots stay still, the green \"live\" dots are gone, the hop on the home screen plays once instead of looping, the pause menu shows one \"new\" mark at a time, and a few labels and key hints that said the same thing twice are gone.",
      "The Loadout's first-person view shows your whole fist under the knife again with the new lower viewmodel.",
    ],
  },
  {
    version: "0.0.5",
    date: "2026-10-05",
    kind: "minor",
    title: "Knives, gloves, finishes and a smoother bhop",
    notes: [
      "Knives, finishes and gloves. Every knife is yours to pick from the start; finishes and gloves unlock by playing.",
      "A new Loadout screen (home menu, pause menu, or your profile under Customise): your hands holding the knife, big and live, with the whole blade in view. Hover any knife, finish or gloves to see it in your hands at once, click to equip. Switch to Close-up to turn the knife in the light by dragging, and Inspect (or F) plays its tricks.",
      "Every item in the Loadout shows as itself, a little render of the knife in that finish or your hand in those gloves, with its rarity as a thin colour line. Locked ones say what unlocks them and how close you are, in one line. Arrow keys, Enter, Q / E and a controller all work there.",
      "Sunset Fade: a carrot that fades from yellow through pink and purple to blue, unlocked at level 20.",
      "More finishes with their own goals: Kiln Hardened for 10,000 jumps (Jackrabbit), Doppelhop Ruby for holding a world record, Doppelhop Sapphire for your first tier 6 map, Tiger Lily, Bramble Web, four Doppelhop phases, Black Pearl and Gamma Hop Emerald.",
      "Every finish pattern is your own: no two players' Sunset Fades are quite the same. Customise shows your pattern number and, for Sunset Fade, how far your fade reaches.",
      "Six knives next to the carrot: the Karrotbit (a hooked carrot karambit), the Bunnyfly balisong, the Daikon-tana, the Clover Cleaver, the Candy Cane Shiv and the Golden Carrot. More join as they are made.",
      "Gloves: seven real styles, each with its own shape and materials, in 22 colourways, on your hands in first person and on your bunny. Sport (padded back panel, vented fingers, velcro strap), Driver (perforated leather with an open back and a snap), Hand Wraps (cloth wraps, bare fingertips, loose tails), Moto (hard knuckle plate, finger guards, long cuff), Specialist (tactical fingerless with a gauntlet cuff), Paw Pads (fuzzy, with toe beans and a paw print) and Garden (canvas with rubber-dipped tips). Stitching, leather grain, cloth weave and worn edges are all drawn live, no textures. Knit, the default, still follows your colourway.",
      "Sport · Pandora is now plum and lilac with amber stitching, to sit better next to the bunny. Gloves you already had keep working.",
      "Knives in other players' hands are about a third bigger, so you can tell a Karrotbit from a Cleaver at a glance.",
      "The carrot grip is tidier: your thumb now rests along the handle under the guard instead of through it, and the Bunnyfly's handles no longer clip your thumb when it flicks open.",
      "Other players on the servers see your knife, finish and gloves, and so do your replays and ghosts.",
      "Each item has a rarity, from Garden to Golden. Unlocking a finish or gloves shows it off with an Equip button that opens the Loadout, and Settings → Viewmodel shows what you have equipped.",
      "Hold the top of the rank board and it shows: overall #1, #2 and #3 wear a gold, silver or bronze crown on their bunny, on the servers, in replays and on their player card. Rank-only colourways (Reigning, Silver Hare, Bronze Hare), frames, trails and titles are yours for as long as you keep the place.",
      "Leaderboards come in pages that fit your screen instead of a long scroll: page numbers, ← / → to flip (Page Up / Page Down in the pause menu), Jump to me, and a search to find any player's row. Map boards keep the world record pinned on every page and your own time below it, with each run's gap to the WR.",
      "The rank board remembers its page and style in the address, so you can share a page, and shows how many points separate each player from the one above. Open any map's full leaderboard from its preview in the map browser.",
      "Landing on a moving block (a door that sinks or slides when you touch it) no longer stops you dead now and then. On bhop_redwood it happened on the first few blocks from the start and sent your next hop out at about 30 u/s. Runs set before this fix keep their times, and their replays and ghosts play back exactly as they were run.",
      "Maps no longer get stuck on the loading screen when a download stalls: it retries on its own, and if the map still can't load you get a Retry button instead of an endless wait.",
      "The loading screen shows texture download progress, and on a slow connection you can skip the wait with Play without textures.",
      "New option in Settings → Keys: Hold to restart. R, B and M then need a half-second hold, so a stray press can't end your run. Off by default.",
      "New achievement, Play with the Owner: spend 30 seconds on the same server as Huddled, who made bunnyhop.lol, and it's yours, with the title \"Hopped with Huddled\". It pops up in game the moment you earn it.",
      "Staff tags on the servers: the owner's chat lines and scoreboard row carry an Owner tag, and server staff a Staff tag, so you know who is running the place. Their player cards show it too.",
    ],
  },
  {
    version: "0.0.4",
    date: "2026-10-05",
    kind: "minor",
    title: "CS:S movement fixes, fixed maps and a new Settings page",
    notes: [
      "Ducking in the air and landing no longer costs you speed: releasing crouch as you land still lets you jump right away, like in CS:S.",
      "Player clips now block you like they do in CS:S. Some shortcuts through invisible walls no longer work.",
      "Runs set before these movement changes keep their times, and their replays and ghosts play back exactly as they were run.",
      "bhop_christmas and bhop_awful3 can be finished: their jump pad and floors are player clips, which you used to fall through. The same fix stops you dropping through the floor at teleport landings on about a dozen more maps.",
      "bhop_alt_saimaa's jump pad launches you as high as it does in CS:S, high enough to reach the next level.",
      "bhop_sharpie moves from tier 1 to tier 2.",
      "New players start on bhop_ambience, a short and friendly tier 1 map, instead of bhop_eazy.",
      "Settings is one page now: a sidebar with an icon per section jumps straight to Mouse & view, Crosshair, HUD, Keys, Ghost, Graphics, Viewmodel, Audio or Account, and follows you as you scroll.",
      "Search every setting with the words you'd actually use: sens, fov, crouch, autohop, carrot, name tags, fullscreen. Typos are fine. Press / to start typing, Enter jumps to the best match.",
      "Every setting explains itself: a short line under its name, and an ⓘ with the details.",
      "Take your setup anywhere: Export copies your settings as one code to paste in a chat, or saves them as a file. Import takes either one, tells you what changed, and has Undo.",
      "Reset one section, or every setting at once, with a confirmation first.",
      "Clearer controls: key binds look like keycaps, switches say On or Off, and every slider has a box for an exact number. Your current settings carry over as they are.",
      "Crouching on Ctrl while you jump on the scroll wheel no longer zooms the page, and neither do Ctrl + plus, minus or 0 or a trackpad pinch while you play. Menus still zoom as usual.",
      "Jumping on the scroll wheel while crouching on Shift works in every browser.",
      "Some screens and glass on maps render correctly instead of as missing textures.",
      "On the servers, type rtv, nominate, timeleft or nextmap in chat without the !, like on CS:S servers. \"nominate arcane\" nominates a map. Only the word on its own counts, so \"can we rtv\" stays a chat message.",
      "kz maps are no longer in the server map rotation, and neither is bhop_caves_original. They are still in the map list to play on your own.",
    ],
  },
  {
    version: "0.0.3",
    date: "2026-10-05",
    kind: "major",
    title: "Real skies, fairer finishes, an inbox",
    notes: [
      "The sky hides everything behind it, like in CS:S: no more seeing other stages through the sky on 65 maps.",
      "3D skyboxes, with their fog, on 23 maps: bhop_japan's mountains, bhop_aztec's terrain and more.",
      "Runs on bhop_monster_jam and bhop_kz_ravine count again. Their start zone sits above the floor, and those runs used to be rejected.",
      "Runs on bhop_ananas, bhop_badges_ausbhop and the bhop_caves_original bonus are no longer rejected as out of sync.",
      "End zones with a teleport on top of them finish your run: bhop_badges, bhop_fps_max_sr, bhop_noob and about 20 other maps finish more reliably.",
      "Restarting on bhop_japan keeps you in the start zone, the same fix bhoptimer servers use.",
      "Refreshed map thumbnails.",
      "Send feedback from the game: Feedback on the home screen or in the pause menu, with an optional screenshot.",
      "Save your progress with an email address. Sign in with a code or the link we send you.",
      "The game goes fullscreen while you play. Turn it off under Settings → Graphics → Display.",
      "Ctrl+W (crouch + forward) no longer closes the tab in Chrome and Edge. Other browsers ask before leaving the page mid-run.",
      "Esc pauses and resumes reliably. If the browser won't give the mouse back, click to resume.",
      "Replays open in first person.",
      "An inbox. Replies to your feedback and announcements from bunnyhop.lol arrive in the game.",
      "Name tags over other players are hidden behind walls now. A setting shows them through walls again if you prefer.",
      "Move the carrot: X, Y and Z offset sliders under Settings → Viewmodel.",
      "Menus and panels no longer overlap at small window sizes.",
      "This changelog. The version in the corner of the home screen and the pause menu opens it, and bunnyhop.lol/changelog lists every version.",
    ],
  },
  {
    version: "0.0.2",
    date: "2026-10-05",
    kind: "minor",
    title: "Stuck stages and faster loading",
    notes: [
      "Fixed nine maps whose stage teleports never fired, so a fall left you stuck with the timer running: bhop_egyptiantemple, bhop_idiosyncrasy, bhop_forresttemple_beta, bhop_fuckfear_fix, bhop_christmas, bhop_japan, bhop_lego2, bhop_omniscient and bhop_strafe_fix.",
      "Maps and textures load faster wherever you are: they are now cached close to you.",
    ],
  },
  {
    version: "0.0.1",
    date: "2026-10-04",
    kind: "major",
    title: "bunnyhop.lol launches",
    notes: [
      "Classic Counter-Strike: Source bunnyhop in your browser. Real Source movement at 100 tick, nothing to install.",
      "About 200 classic bhop maps from GameBanana, tiered T1 to T6, with bonus tracks and stage splits. Browse them by tier or by collection: Iconic, Short, Modern and the Prestige classics.",
      "Five styles: Normal (autohop), Legit Scroll, W-Only, Sideways and Half-Sideways. Each has its own personal bests and leaderboards.",
      "Verified leaderboards. Every run uploads a tick-exact replay, and the server plays it again before the time counts.",
      "A replay of every finished run. Watch it in first person, chase, free, flyby or auto-director cameras, with a speed graph, and export it as an MP4 with the HUD, keys and sound.",
      "Ghosts: race your PB, the world record or anyone's run from the leaderboard, with a live delta on the HUD.",
      "Online servers, Easy (T1 to T3) and Hard (T4 to T6), with map votes, RTV, nominations, chat and spectating. Runs you finish online are verified like solo runs.",
      "Profiles with points, ranks, levels and achievements, and cosmetics to unlock for your player card, ghost and trail.",
      "The bunny, our own character, and its carrot blade in first person: Mouse 1 slashes, Mouse 2 stabs, F inspects.",
      "Sound effects and music, a HUD you can lay out yourself, and every key rebindable.",
      "Play as a guest from the first click. Link Discord to keep your progress on any device.",
    ],
  },
];

/** Compare two dotted version strings numerically: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** "5 Oct 2026" in the reader's locale (or a fixed en-GB one for static HTML), from an ISO date. Parsed as UTC
 *  midnight so the calendar day never shifts; falls back to the ISO string where Intl is missing. */
export function prettyDate(iso: string, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
  } catch {
    return iso;
  }
}

export const KIND_LABEL: Record<ChangelogEntry["kind"], string> = { major: "Major", minor: "Minor" };
