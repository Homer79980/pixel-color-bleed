# Pixel Color Bleed for Photoshop

An open-source Adobe Photoshop UXP panel that extends a transparent image
outward with solid, opaque pixels while preserving local color structure.

The extension is designed for UI assets, sprites, icons, and other artwork
that needs extra pixels around the silhouette without changing the original
layer.

## Repository layout

- `source/photoshop/pixel-color-bleed-plugin/` - UXP source code and icons.
- `releases/1.11.0/pixel-color-bleed-1.11.0.ccx` - installable Photoshop package.

## Install the plugin

1. Download the CCX package from `releases/1.11.0/`.
2. Open Photoshop and install the `.ccx` file through the plugin manager.
3. Open the panel named `Color Pixel Bleed` from the Plugins menu.
4. Select an RGB image layer with transparency and run the panel.

The generated extension is placed on a new layer below the selected layer.
The original artwork remains unchanged.

## Controls

- Extension pixels: outward extension radius in pixels.
- Hue: `-180` to `180` degrees.
- Saturation: `-100` to `100`.
- Lightness: `-100` to `100`.
- Expand canvas: disabled by default; enable it when the document boundary
  would otherwise clip the generated pixels.

Color fusion is always enabled. Hue, saturation, and lightness adjustments
apply only to generated extension pixels and support both a slider and direct
numeric input.

## Development

The plugin requires Photoshop 23.0 or later and an RGB document with an
alpha-bearing image layer.

To load the source during development:

1. Enable Photoshop developer mode.
2. Choose `Plugins > Development > Load Unsigned Plugin`.
3. Select `source/photoshop/pixel-color-bleed-plugin/`.

The main script is plain JavaScript and can be checked with:

```text
node --check source/photoshop/pixel-color-bleed-plugin/main.js
```

## License

This project is released under the MIT License. See `LICENSE`.
