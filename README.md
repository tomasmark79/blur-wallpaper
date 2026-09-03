# Blur Wallpaper

[![PayPal](https://img.shields.io/badge/PayPal-Donate-blue?logo=paypal)](https://paypal.me/TomasMark)

**Blur your GNOME wallpaper without a permanent GPU blur effect.**

Blur Wallpaper is a GNOME Shell 46–50 extension that creates a static blurred copy of your current wallpaper. The generated image is used as the desktop background, providing smooth, artifact-free workspace transitions without applying a live blur effect.

## Features

- Adjustable blur intensity from 0 to 300 px
- Static pre-rendered blur for better performance
- Separate processing of light and dark wallpapers
- Automatic refresh when the wallpaper changes
- Cached generated images for faster reuse
- Restores the original wallpaper when the extension is disabled
- Simple settings page integrated with GNOME Extensions

## Requirements

- GNOME Shell 46, 47, 48, 49, or 50
- [ImageMagick](https://imagemagick.org/) with the `magick` command available in `PATH`

For example, install ImageMagick on Fedora with:

```bash
sudo dnf install ImageMagick
```

Or on Ubuntu/Debian with:

```bash
sudo apt install imagemagick
```

## Build and install

Build and install the extension locally:

```bash
./build.sh -bi
```

Then log out and back in when using Wayland, or let the build script log out the current GNOME session:

```bash
./build.sh -bil
```

Enable the extension:

```bash
gnome-extensions enable blur-wall@digitalspace.name
```

Open its settings from the Extensions application or with:

```bash
gnome-extensions prefs blur-wall@digitalspace.name
```

Set the intensity to `0` to use the original wallpaper without blur. Generated wallpapers are stored in `~/.cache/blur-wallpaper` and kept for reuse.

## License

GPL-3.0-or-later. Copyright © 2026 Tomáš Mark.
