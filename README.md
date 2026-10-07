# Blur Wallpaper

Creates a static blurred copy of your GNOME wallpaper for smooth workspace
transitions without a permanent GPU blur effect.

## Features

- Adjustable blur intensity from 0 to 300 px
- Separate processing of light and dark wallpapers
- Automatic refresh when the wallpaper changes
- Cached generated images for faster reuse
- Restores the original wallpaper when disabled
- Preferences integrated with GNOME Extensions

## Requirements

Declared GNOME Shell versions: **46–50**, as listed in `metadata.json`.
ImageMagick with the `magick` command must be available in `PATH` at runtime.

Build tools: Bash, Python 3, Node.js (syntax checks), zip and `glib-compile-schemas`.
Local installation also requires `gnome-extensions`.

## Installation

From the project directory:

```bash
./build.sh --install
```

On Wayland, log out and back in when needed to load new or changed JavaScript,
then enable the extension:

```bash
gnome-extensions enable blur-wall@digitalspace.name
```

Installation updates the user copy without enabling the extension or logging you out.

## Usage

Open Preferences from the Extensions application or with:

```bash
gnome-extensions prefs blur-wall@digitalspace.name
```

Choose a blur intensity and allow a moment for the image to be generated.
Set intensity to `0` to use the original wallpaper without blur.
Generated wallpapers are cached in `~/.cache/blur-wallpaper` for reuse.

## Development

```bash
./build.sh --check
./build.sh
```

The output is `dist/blur-wall@digitalspace.name.zip`. `-b` and `-r` are build aliases;
`-i`, `-bi` and `-ri` build the current sources and install them.

Compare with a separately saved previous distribution archive, if available:

```bash
./build.sh --compare-zip /path/to/previous-blur-wall.zip
```

This checks identical paths and bytes for every packaged file, including metadata.
ZIP timestamps and compression may differ. The package keeps the existing layout:
JavaScript modules, metadata and the XML schema, without a compiled schema or LICENSE.
The schema is validated during the build and compiled by GNOME during installation.

For runtime changes, verify intensity `0` and nonzero values, light/dark wallpapers,
wallpaper changes, cached image reuse and restoration after disabling.
Build checks alone do not confirm behavior on every declared Shell version.

## Troubleshooting

If blur is not generated, check that `magick` is available in the GNOME session.
Start a fresh session if an installed code change does not appear.
Report problems in the [issue tracker](https://github.com/tomasmark79/blur-wallpaper/issues)
with reproduction steps and your GNOME Shell version.

## License

[GPL-3.0-or-later](LICENSE). Copyright © 2026 Tomáš Mark.

[GitHub](https://github.com/tomasmark79/blur-wallpaper) · [Donate via PayPal](https://paypal.me/TomasMark)
