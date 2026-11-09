# Map art

The map's pictures are original: an image model made them from the prompts below, without reference images.
`python3 art/prepare.py SOURCE_DIR` turns the generated files, named as below, into `src/map/art`.

STYLE: Original science-fiction game art in the manner of late-1990s hand-painted and pre-rendered computer game graphics. Painterly and rich, slightly gritty, visible brushwork on surfaces, soft atmospheric glow, retro-futuristic industrial engineering, a palette of warm amber and deep teal blue. Entirely original design. No text, no letters, no logos, no watermark, no interface elements.

1. nebula (landscape, 1536x1024): A deep space backdrop. A dim diagonal nebula of dusty teal and muted violet with amber wisps, fine scattered stars, large calm dark areas. No planets, no ships, no bright central object. Dark overall, so that text can be read over it.

2. planet-yard (square, 1024x1024): One whole planet centred on a flat pure black background, with a clear margin around it. A steel-grey industrial world, its surface covered in dark plates, trenches and a grid of tiny warm city lights on the night side. Lit from the upper left, with a soft terminator and a thin pale blue atmosphere rim.

3. planet-cryo (square, 1024x1024): One whole planet centred on a flat pure black background, with a clear margin around it. A frozen pale blue world with cracked ice plains, white polar caps and faint turquoise fissures. Lit from the upper left, with a soft terminator and a thin cold atmosphere rim.

4. ship-blue (square, 1024x1024): One small spacecraft seen exactly from above, nose pointing straight up, centred on a flat solid magenta background (#FF00FF) with nothing else on it. A narrow angular dart with swept wings, cobalt blue hull plates, dark steel panels, a pale cockpit and two glowing engine nozzles at the tail. Pre-rendered look with metallic highlights. No shadow on the background.

5. ship-copper (square, 1024x1024): One small spacecraft seen exactly from above, nose pointing straight up, centred on a flat solid magenta background (#FF00FF) with nothing else on it. A rounded disc-shaped hull with a short prow and twin rear engine pods, warm copper and terracotta plating, cream panels and a pale cockpit. Pre-rendered look with metallic highlights. No shadow on the background.

6. flagship (square, 1024x1024): One large capital ship seen exactly from above, nose pointing straight up, centred on a flat solid magenta background (#FF00FF) with nothing else on it. A long heavy cruiser with a stepped superstructure, copper and dark steel armour, rows of small lit windows and a cluster of large engines at the tail. Pre-rendered look with metallic highlights. No shadow on the background.

7. ui-frame (landscape, 1536x1024): A flat front view of an empty rectangular control-panel frame made of brushed dark metal, with riveted corner brackets, bevelled edges and small warm amber indicator lamps. The frame is symmetrical, runs close to the edges of the image, and its whole centre is a plain flat near-black area. No screens, no buttons with symbols, no text.

1. sun (square, 1024x1024): One whole star centred on a flat pure black background, with a clear margin around it. A blazing amber and gold sun with a granular boiling surface, darker sunspots, thin arcing prominences along the rim and a soft fiery corona fading into the black. Evenly lit from within, with no dark side.

2. planet-range (square, 1024x1024): One whole planet centred on a flat pure black background, with a clear margin around it. A scorched ochre and rust desert world covered in impact craters, burn scars and straight test-range trenches, with thin dust clouds. Lit from the upper left, with a soft terminator and a thin warm atmosphere rim.

3. planet-roadstead (square, 1024x1024): One whole planet centred on a flat pure black background, with a clear margin around it. A calm teal and emerald ocean world with pale swirling clouds, small golden islands and a glowing warm coastline. Lit from the upper left, with a soft terminator and a thin bright atmosphere rim.

4. station-command (square, 1024x1024): One large orbital command station seen exactly from above, centred on a flat solid magenta background (#FF00FF) with nothing else on it. A wide armoured ring joined by four spokes to a domed central hub, dark steel and copper plating, rows of small warm lit windows and antenna masts. Pre-rendered look with metallic highlights. No shadow on the background.

5. gate (square, 1024x1024): One huge circular hyperspace gate seen exactly from the front, centred on a flat solid magenta background (#FF00FF). A heavy segmented ring of dark steel and brass with four large clamps and amber lamps set around it. The whole centre of the ring is empty and shows the same flat magenta background. Pre-rendered look with metallic highlights. No shadow on the background.

6. ship-scout (square, 1024x1024): One tiny scout probe seen exactly from above, nose pointing straight up, centred on a flat solid magenta background (#FF00FF) with nothing else on it. A slim needle hull with two small fins, a large sensor dish near the nose, pale steel and cobalt blue paint and one glowing engine at the tail. Pre-rendered look with metallic highlights. No shadow on the background.

7. frame-light (landscape, 1536x1024): A flat front view of an empty rectangular panel frame. A slim brushed dark metal border only a few percent of the image wide, with a thin brass inner line and small plain corner brackets with one rivet each. No pipes, no lamps, no vents. The frame is symmetrical, runs right along the edges of the image, and its whole centre is a plain flat near-black area.

8. station-research (square, 1024x1024): One large orbital research observatory seen exactly from above, centred on a flat solid magenta background (#FF00FF) with nothing else on it. A round central hub carrying one huge dish antenna made of a pale steel lattice, turned up towards the viewer, with a bright teal sensor eye at its centre. Around the hub runs a slender ring of glass laboratory domes glowing soft teal, and three long thin sensor booms reach outwards with small amber lamps at their tips. Dark steel and pale brass plating. Pre-rendered look with metallic highlights. No shadow on the background.


9. station-yard (square, 1024x1024): One large orbital shipyard seen exactly from above, centred on a flat solid magenta background (#FF00FF) with nothing else on it. A massive square dry dock made of an open girder framework: a thick armoured backbone along its left side with three long parallel slipways reaching out to the right, open at their right ends. Two slipways hold half-built ship hulls with bare ribs and patches of copper plating; the third slipway is empty. Two heavy gantry cranes bridge the slipways. Bright white welding sparks and amber floodlights shine on the hulls, and small warm lamps line the girders. Dark steel and copper plating; the open spaces between the girders show the flat magenta background. Pre-rendered look with metallic highlights. No shadow on the background.

10. station-inspection (portrait, 1024x1536): One orbital inspection checkpoint seen exactly from above, centred on a flat solid magenta background (#FF00FF) with nothing else on it. A tall open frame shaped like a rectangle with cut corners, about two thirds as wide as it is tall and filling most of the image's height, built of heavy dark steel girders with pale brass trim. Along the inner edge of its left and right girders sit rows of small scanner heads with glowing violet lenses that face into the frame. Small amber lamps mark the four cut corners, and two short antenna masts stand out from the middle of the top and the bottom. The whole inside of the frame is empty and shows the same flat magenta background. Pre-rendered look with metallic highlights. No shadow on the background.

The inspection is that checkpoint: the ships under review stand in lanes across its open middle. `CHECKPOINT` in `src/map/layout.ts` holds the share of the art the open middle takes, measured on this picture; a new picture needs it measured again.

The shipyard is a dock over the limb of the system's home world; `planet-yard` is that home world for a repository without its own planet. A single new picture is prepared alone: `python3 art/prepare.py SOURCE_DIR --only station-yard`.

## Ship classes

Same STYLE as the first list. Frigates and cruisers carry tasks with more reasoning effort.

1. ship-blue-frigate (square, 1024x1024): One medium warship seen exactly from above, nose pointing straight up, centred on a flat solid magenta background (#FF00FF) with nothing else on it. A long angular frigate with swept forward wings and a spine of armour plates, cobalt blue hull, dark steel panels, a pale cockpit and three glowing engine nozzles at the tail. Pre-rendered look with metallic highlights. No shadow on the background.

2. ship-blue-cruiser (square, 1024x1024): One heavy battlecruiser seen exactly from above, nose pointing straight up, centred on a flat solid magenta background (#FF00FF) with nothing else on it. A massive arrowhead hull with layered cobalt blue armour, dark steel gun decks along both sides, a raised bridge tower and a wide bank of five glowing engines at the tail. Pre-rendered look with metallic highlights. No shadow on the background.

3. ship-copper-frigate (square, 1024x1024): One medium warship seen exactly from above, nose pointing straight up, centred on a flat solid magenta background (#FF00FF) with nothing else on it. A rounded oval hull with a long prow, side engine pods on short pylons, warm copper and terracotta plating, cream panels and a pale cockpit. Pre-rendered look with metallic highlights. No shadow on the background.

4. ship-copper-cruiser (square, 1024x1024): One heavy battlecruiser seen exactly from above, nose pointing straight up, centred on a flat solid magenta background (#FF00FF) with nothing else on it. A broad rounded hull like a fat teardrop, thick copper and terracotta armour rings, cream superstructure domes and four large glowing engines at the tail. Pre-rendered look with metallic highlights. No shadow on the background.

## Machines

Same STYLE as the first list. Every machine is a reactor in the galaxy; the map draws the rings of its load around it and
lights its pale core in the colour of its status. A "trim" sprite: `python3 art/prepare.py SOURCE_DIR --only reactor-core`.

1. reactor-core (square, 1024x1024): One compact round orbital reactor seen exactly from above, centred on a flat solid magenta background (#FF00FF) with nothing else on it, with a wide clear margin of magenta all around it. A thick circular armoured housing of dark steel and brass with six evenly spaced heavy clamps and small amber lamps around its rim, and in its middle one round glass dome over a bright pale white glowing reactor core. The outline is a clean circle: no wings, no arms, no antennas, nothing reaching out of the circle. Pre-rendered look with metallic highlights. No shadow on the background.

## Subscriptions

Same STYLE as the first list. Every subscription is a fuel tank in the galaxy; the map draws the fuel in the tank's
empty glass, the day lamps beside it and the admiral's badge on top. These three are "trim" sprites: `prepare.py` crops
them to what shows, so that `TANK_GLASS` in `layout.ts`, the glass as shares of the sprite, holds for the picture.
Measure it again after a new tank: `python3 art/prepare.py SOURCE_DIR --only fuel-tank fuel-cell admiral`.

1. fuel-tank (portrait, 1024x1536): One upright orbital fuel tank seen exactly from the front, centred on a flat solid magenta background (#FF00FF) with nothing else on it, with a clear margin of magenta all around it. A tall cylinder with domed ends standing in a low cradle of dark steel girders, weathered steel and teal paint, thick riveted bands near the top and the bottom, and a few small amber lamps on the bands. Down the middle of its front runs one wide straight vertical glass sight window, from just below the top band to just above the bottom band, about a third of the tank's width. The window is completely empty: smooth deep near-black glass with only faint reflections, nothing inside it. Pre-rendered look with metallic highlights. No shadow on the background.

2. fuel-cell (square, 1024x1024): One small spare fuel canister seen exactly from the front, centred on a flat solid magenta background (#FF00FF) with nothing else on it, with a clear margin of magenta all around it. A short stubby upright capsule with rounded ends, dark steel end caps, a glass ring around its middle through which bright glowing amber liquid fuel is seen, and a small carrying handle on top. Pre-rendered look with metallic highlights. No shadow on the background.

3. admiral (square, 1024x1024): One small military insignia seen exactly from the front, centred on a flat solid magenta background (#FF00FF) with nothing else on it, with a clear margin of magenta all around it. A bold five-pointed gold star with a raised bevel on a round deep navy blue enamel disc with a thin gold rim, and a short pair of swept gold wings spreading from behind the disc. Simple bold shapes that stay readable when very small. Polished metal highlights. No shadow on the background.

## Skies of the star systems

STYLE: Original science-fiction game art in the manner of late-1990s hand-painted computer game graphics. A deep space backdrop in landscape format, 1536x1024. Painterly and rich, visible brushwork, fine scattered stars. Dark overall, with large calm dark areas, so that text and bright objects can be read over it. The middle of the image stays dim and open. No planets, no ships, no suns, no bright central object. Entirely original design. No text, no letters, no logos, no watermark, no interface elements.

1. backdrop-ember: Smouldering nebula of deep crimson and rust, like cooling embers, drifting in broad horizontal layers with thin orange edges.

2. backdrop-aurora: Long hanging curtains of emerald and sea green light falling from the top of the image, fading into black below.

3. backdrop-ice: Cold pale blue and steel nebula with sharp crystalline shards of gas fanning out from the corners.

4. backdrop-storm: A violet and indigo storm cloud in space, laced with thin branching filaments of pale lilac.

5. backdrop-dune: Rolling banks of warm golden and sand-coloured dust, like dunes seen from far away, with soft dark hollows between them.

6. backdrop-tide: Great slow waves of dark teal and deep turquoise gas curling across the image like an ocean swell.

7. backdrop-pillars: Tall dark towers of dust rising from the bottom edge, rimmed with dim rose and magenta light.

8. backdrop-remnant: A huge faint broken ring of ash grey gas around the edges of the image, with a thin burning orange rim and a dark empty middle.

9. backdrop-cluster: A deep indigo field crowded with fine stars in dense curving streams, with almost no gas.

10. backdrop-marsh: Murky olive and copper clouds, heavy and slow, with sickly pale green glows in the distance.

## The science station's staff

Two portraits speak in the science station's panel: the analyst, the reflection itself, and the archive keeper, who tells
what the board knows without an agent. Each has one dominant colour and one big feature, so that it still reads at
22 pixels. Each prompt follows the first STYLE line of this file, without its "pre-rendered" and "industrial" words.
`python3 art/prepare.py SOURCE_DIR --portraits` scales `portrait-analyst.png` and `portrait-archivist.png` into JPEGs.

1. portrait-analyst (square, 1024x1024): A head-and-shoulders portrait of a fictional research scientist aboard an orbital observatory, turned three-quarters towards the viewer, centred and filling most of the square frame. Deep teal is the dominant colour. One big, bold feature: a large round brass lens visor over the right eye that glows bright teal. Short silver hair, a high-collared dark teal lab coat with small brass clasps. Lit from below and in front by the soft teal glow of an unseen screen, with a warm amber rim light from behind. Calm, attentive, intelligent expression. A plain dark teal-black painted background with a soft vignette and nothing else in it. The silhouette and the glowing visor must read clearly even when the picture is shown very small.

2. portrait-archivist (square, 1024x1024): A head-and-shoulders portrait of a fictional archive-keeper robot of an orbital observatory, facing the viewer, centred and filling most of the square frame. Warm amber is the dominant colour. One big, bold feature: a round domed brass head with a single large glowing amber lamp eye in its middle. Weathered brass and dark steel plates with a few rivets, a thick ribbed neck. Behind its shoulders, dark shelves of small glowing data cassettes, softly blurred. Lit warmly by the glow of its own eye, with a cool teal rim light from behind. Calm and patient bearing. A dark background with a soft vignette. The round head and the glowing eye must read clearly even when the picture is shown very small.

## The art of one project

A repository may have its own sky, home planet and emblem. The home planet is the system's home world, drawn large at its left edge under the shipyard's dock. They live in `board-art/<repo>/` in the data home (`~/.teamster/board-art/<repo>/` by default), never in this repository: a project's name and theme can be private. Nothing here is generated automatically, and a project without art keeps the shared pictures.

1. Read the project's README and write its theme in one short sentence: what the project is like, as an image. The prompts carry only that theme, never code, file names, or text taken from the project.
2. Fill the three prompts below, each after its style line: the sky after the STYLE of the skies above, the planet and the emblem after the first STYLE of this file.
3. Run a teamster scout in a new empty directory with `image_gen` and the prompts, asking only for the file paths. No reference images. Look at every image yourself and generate again until it reads as this project. Name the files `sky.png`, `planet.png` and `emblem.png`.
4. Prepare them, from `board/web`:

   ```sh
   python3 art/prepare.py SOURCE_DIR --project ~/.teamster/board-art/<repo>
   ```

   `<repo>` is the repository's folder name as the board shows it. Any of the three files may be left out. The map picks up new art when its tab is opened again.

sky (landscape, 1536x1024): `<THEME>`, as a nebula or dust cloud, not as objects.

planet (square, 1024x1024): One whole planet centred on a flat pure black background, with a clear margin around it. `<WORLD>`. The planet must read at a glance from far away: one dominant colour and one large feature, with no buildings, no figures, no objects and no small details on it. Lit from the upper left, with a soft terminator and a thin atmosphere rim.

The planet takes the STYLE without its palette sentence, and a world type for the theme instead of the theme sentence (`<WORLD>`): a colour that no other project's planet uses and one big feature, such as rings, a grid of lights or a single storm. Small scenes on the surface make all planets look alike.

emblem (square, 1024x1024): One round heraldic badge seen from the front, filling most of the image, centred on a flat solid magenta background (#FF00FF) with nothing else on it. A plain brass rim around a field of `<ENAMEL>` enamel, and on it one single bold symbol: `<SYMBOL>`, as one large clear silhouette in polished brass filling most of the field. No scene, no landscape, no figures, no small details and no other objects, so that it still reads at 30 pixels. No magenta in the badge. Pre-rendered look with metallic highlights. No shadow on the background.

The emblem takes one object for the theme instead of the theme sentence (`<SYMBOL>`, such as a horseshoe or a keyhole) and a colour that tells it from the other projects (`<ENAMEL>`): a whole scene turns to mush at 30 pixels.
