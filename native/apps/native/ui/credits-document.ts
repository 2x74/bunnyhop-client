// The website's /credits page, verbatim from upstream apps/web/credits.html at 042dca41. Refresh it with the vendored
// web sources; credits.ts renders it.
export const CREDITS_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Credits · bunnyhop.lol</title>
  <meta name="description" content="Map credits, community contributions, software, fonts, art and audio used by bunnyhop.lol." />
  <meta name="robots" content="index, follow, max-image-preview:large" />
  <meta name="theme-color" content="#0d0f14" />
  <meta name="color-scheme" content="dark" />
  <link rel="canonical" href="https://bunnyhop.lol/credits" />
  <link rel="icon" href="/favicon.ico" sizes="32x32 48x48" />
  <link rel="icon" type="image/svg+xml" href="/src/assets/favicon.svg" />
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
  <link rel="manifest" href="/site.webmanifest" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="bunnyhop.lol" />
  <meta property="og:locale" content="en_US" />
  <meta property="og:url" content="https://bunnyhop.lol/credits" />
  <meta property="og:title" content="Credits · bunnyhop.lol" />
  <meta property="og:description" content="Map credits, community contributions, software, fonts, art and audio used by bunnyhop.lol." />
  <meta property="og:image" content="https://bunnyhop.lol/og/site/about.jpg?v=1" />
  <meta property="og:image:secure_url" content="https://bunnyhop.lol/og/site/about.jpg?v=1" />
  <meta property="og:image:type" content="image/jpeg" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="bunnyhop.lol: classic CS:S bhop, no install" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="Credits · bunnyhop.lol" />
  <meta name="twitter:description" content="Map credits, community contributions, software, fonts, art and audio used by bunnyhop.lol." />
  <meta name="twitter:image" content="https://bunnyhop.lol/og/site/about.jpg?v=1" />
  <meta name="twitter:image:alt" content="bunnyhop.lol: classic CS:S bhop, no install" />
  <link rel="stylesheet" href="/src/about/about.css" />
  <link rel="stylesheet" href="/src/about/legal.css" />
</head>
<body>
  <header class="top">
    <a class="wordmark" href="/" aria-label="bunnyhop.lol home"><svg class="logo-mark" viewBox="0 0 64 64" aria-hidden="true"><path d="M8 47 Q14.5 33 21 47 Q29 25 37 47 Q46.5 15 56 47" fill="none" stroke="currentColor" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="56" cy="47" r="4.5" fill="#fff"/></svg><span><span class="wm-name">bunnyhop</span><span class="wm-tld">.lol</span></span></a>
    <nav aria-label="Site"><a href="/maps">Maps</a><a href="/servers">Play online</a><a href="/about">About</a><a class="btn" href="/">Play now</a></nav>
  </header>
  <main class="legal credits">
    <h1>Credits</h1>
    <p class="lede">bunnyhop.lol is built on the work of the bhop/KZ mapping community and many others. Thank you to the people who made these maps, tools, libraries and resources.</p>
    <p>Map author or rights holder? Want a credit fixed or a map removed? Email <a href="mailto:support@bunnyhop.lol">support@bunnyhop.lol</a> with the map name — we'll fix or remove it promptly. See <a href="/terms#copyright">copyright and takedowns</a>.</p>
    <nav class="legal-contents" aria-label="Contents">
      <h2>On this page</h2>
      <ol>
        <li><a href="#contributors">Contributors</a></li>
        <li><a href="#maps">Maps</a></li>
        <li><a href="#zones">Zones and tiers</a></li>
        <li><a href="#code">Engine and code</a></li>
        <li><a href="#fonts">Fonts</a></li>
        <li><a href="#art">Art and audio</a></li>
      </ol>
    </nav>
    <section aria-labelledby="contributors">
      <h2 id="contributors">Contributors</h2>
      <ul>
        <li><strong>Luna</strong> — the <a href="https://github.com/2x74/bunnyhop-client">native desktop client</a>, plus testing, bug reports and moderation.</li>
      </ul>
      <p>Players who contribute to the game or its clients get the Contributor badge in game and on Discord.</p>
    </section>
    <section aria-labelledby="maps">
      <h2 id="maps">Maps</h2>
      <p><!--credits:count--> maps from our public catalogue. Maps belong to their authors and rights holders. Expand a letter to see the credits, sorted alphabetically without the <code>bhop_</code> or <code>bh_</code> prefix.</p>
      <p>For community maps, “uploaded by” is the GameBanana submitter recorded in the catalogue; this may be an archivist rather than the original creator. Original maps made for bunnyhop.lol are marked below, including Aero, Backrooms, Hermes, Meadow and Plaza.</p>
      <p>Licences are shown as recorded at the source, including “unknown”, “none” and “custom”; a missing tag is “Not stated”. Source links lead to the upload page, mirror or original project.</p>
      <!--credits:maps-->
    </section>
    <section aria-labelledby="zones">
      <h2 id="zones">Zones and tiers</h2>
      <p><a href="https://github.com/srcwr/zones-cstrike">srcwr/zones-cstrike</a> supplies standardized bhoptimer zones and community tiers: the cutehops dump courtesy of may/lilac, with the sourcejump dump courtesy of Eric merged on top.</p>
      <p>Additional zones come from Prestige Gaming’s GMod bhop database, released by Gravious in <a href="https://github.com/GMSpeedruns/Flow-Release">GMSpeedruns/Flow-Release</a>. Thank you to these communities for preserving the timing data.</p>
    </section>
    <section aria-labelledby="code">
      <h2 id="code">Engine and code</h2>
      <ul>
        <li><a href="https://github.com/Hona/playsrc">playsrc</a> — original playsrc material is MIT licensed. Copyright © 2026 playsrc contributors.</li>
        <li><a href="https://github.com/ValveSoftware/source-sdk-2013">Source SDK 2013</a> — derived portions remain © Valve Corporation under the <a href="https://github.com/ValveSoftware/source-sdk-2013/blob/master/LICENSE">Source SDK licence</a>, separately from playsrc’s MIT material.</li>
        <li><a href="https://github.com/mrdoob/three.js">three.js</a> — MIT.</li>
        <li><a href="https://github.com/gkjohnson/three-mesh-bvh">three-mesh-bvh</a> — MIT.</li>
        <li><a href="https://github.com/gkjohnson/three-gpu-pathtracer">three-gpu-pathtracer</a> — MIT.</li>
        <li><a href="https://github.com/mozillareality/xatlas-web">xatlas-web</a> — MIT.</li>
        <li><a href="https://github.com/lipis/flag-icons">flag-icons</a> — MIT.</li>
        <li><a href="https://github.com/BinomialLLC/basis_universal">Basis Universal</a> texture transcoder — Apache-2.0.</li>
        <li><a href="https://github.com/jamsinclair/jSquash">@jsquash/jpeg and @jsquash/webp</a> image codecs — Apache-2.0.</li>
        <li><a href="https://github.com/yisibl/resvg-js">resvg / @resvg/resvg-wasm</a>, used for server-rendered images — MPL-2.0.</li>
      </ul>
      <p>The moderation word list uses the English <a href="https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/blob/5faf2ba42d7b1c0977169ec3611df25a3c08eb13/en">List of Dirty, Naughty, Obscene, and Otherwise Bad Words</a>. Copyright Shutterstock, Inc. and the LDNOOBW contributors. Licensed under <a href="https://creativecommons.org/licenses/by/4.0/">Creative Commons Attribution 4.0 International (CC BY 4.0)</a>. Changes: none to the entries. Matching uses whole words and phrases, with exceptions for ordinary game nicknames.</p>
    </section>
    <section aria-labelledby="fonts">
      <h2 id="fonts">Fonts</h2>
      <p>These fonts are licensed under the <a href="https://openfontlicense.org/">SIL Open Font License 1.1</a>. Copyright remains with their respective project authors.</p>
      <ul>
        <li><a href="https://github.com/rsms/inter">Inter</a> — the Inter Project Authors; used in generated images and the site’s font stack.</li>
        <li><a href="https://github.com/sevmeyer/oxanium">Oxanium</a> — the Oxanium Project Authors; <a href="/custom-css/themes/source-oxanium-OFL.txt">notice</a>.</li>
        <li><a href="https://github.com/jpt/barlow">Barlow and Barlow Condensed</a> — the Barlow Project Authors; <a href="/custom-css/themes/clean-barlow-OFL.txt">Barlow notice</a>, <a href="/custom-css/themes/proxy-condensed-OFL.txt">Barlow Condensed notice</a>.</li>
        <li><a href="https://github.com/googlefonts/AntonFont">Anton</a> — the Anton Project Authors; <a href="/custom-css/themes/proxy-anton-OFL.txt">notice</a>.</li>
        <li><a href="https://github.com/NDISCOVER/Cinzel">Cinzel</a> — the Cinzel Project Authors; <a href="/custom-css/themes/duel-cinzel-OFL.txt">notice</a>.</li>
        <li><a href="https://fonts.google.com/specimen/VT323">VT323</a> — the VT323 Project Authors; <a href="/custom-css/themes/dex-vt323-OFL.txt">notice</a>.</li>
        <li><a href="https://fonts.google.com/specimen/Press+Start+2P">Press Start 2P</a> — the Press Start 2P Project Authors; <a href="/custom-css/press-start-2p-OFL.txt">notice</a>.</li>
        <li><a href="https://github.com/theleagueof/league-gothic">League Gothic</a> and <a href="https://github.com/JetBrains/JetBrainsMono">JetBrains Mono Bold</a> — the League Gothic and JetBrains Mono Project Authors; used in the Hermes map’s baked lettering.</li>
      </ul>
    </section>
    <section aria-labelledby="art">
      <h2 id="art">Art and audio</h2>
      <p>Textures, models, animations and sounds from Counter-Strike: Source and Half-Life 2 are © Valve Corporation. Original bunny meshes, hats, knives and glove artwork were made for bunnyhop.lol; some skeletons and animation data come from Valve assets.</p>
      <p>Replacement texture packs include materials from <a href="https://polyhaven.com/">Poly Haven</a> under <a href="https://creativecommons.org/publicdomain/zero/1.0/">CC0</a>. Individual asset source links are recorded in the <a href="/texture-packs/original-demo.bhpack.json">texture pack manifest</a>.</p>
      <p>Music and generated sound effects were created for bunnyhop.lol with <a href="https://elevenlabs.io/">ElevenLabs Music and Sound Effects</a>. This acknowledges the tools used; it does not assign a blanket open licence to the recordings.</p>
      <p>The classic “perfect”, “godlike” and “holy shit” announcer lines come from community sample archives, including the <a href="https://www.unrealsoftware.de/files_show.php?file=4778">UT/Quake &amp; Headshot ULTIMATE Sound System archive uploaded by CrawiS ([CW])</a>. Original rights holders retain their rights: please <a href="mailto:support@bunnyhop.lol">contact us</a> for corrections or removal.</p>
      <p>The Hermes map includes Nous Research’s Hermes logo/caduceus and poster artwork from <a href="https://github.com/NousResearch/hermes-agent">hermes-agent</a>, used under its <a href="https://github.com/NousResearch/hermes-agent/blob/main/LICENSE">MIT licence</a>. Its notice is also packed into the map.</p>
    </section>
  </main>
  <footer class="foot"><p class="foot-links"><a href="/">Play bunnyhop.lol</a><a href="/about">About</a><a href="/changelog">Changelog</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a> <a href="/credits">Credits</a><a href="mailto:support@bunnyhop.lol">Contact</a></p><p class="credits-disclaimer">bunnyhop.lol is an independent project and is not affiliated with or endorsed by Valve Corporation. Counter-Strike, Source, Half-Life and Steam are trademarks of Valve Corporation.</p></footer>
</body>
</html>
`;
