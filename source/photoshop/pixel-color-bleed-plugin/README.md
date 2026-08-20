# 颜色像素扩散 UXP Plugin

This Photoshop UXP panel creates a new pixel layer below the selected layer.
It extends the artwork outward in memory instead of duplicating and merging
Photoshop layers repeatedly.

Features:

- Solid, fully opaque pixels in the generated region.
- Structure-guided, wavefront extrusion that matches small interior patches
  before advancing outward, so color bands continue along the local contour
  instead of forming independent radial streaks.
- Automatic source-only color-contour guidance. Strong interior boundaries
  are fitted as local curves and smoothed along the silhouette before the
  outward wavefront starts.
- Weighted rotated subpixel sampling preserves the blended appearance of the
  1.8 color pipeline while the fitted curve controls structural direction.
- A small inward overlap bridge closes anti-aliased transparency gaps at the
  source/extension seam.
- Edge-aware color softening without mixing unrelated color bands.
- Adjustable extension radius plus Photoshop-style hue, saturation, and
  lightness adjustments. Each adjustment supports both a slider and a numeric
  input.
- Color fusion is always enabled for the generated extension pixels.
- Optional canvas expansion to prevent clipping (disabled by default).
- Original artwork layer remains unchanged.

## Install for development

1. Open Photoshop and enable `Plugins > Development > Enable Developer Mode`.
2. Open `Plugins > Development > Load Unsigned Plugin...`.
3. Select this folder, `pixel-color-bleed-plugin`.
4. Open the panel from `Plugins > Pixel Color Bleed`.

Select one image layer, set the controls, and click `生成颜色扩展`.

The plugin requires Photoshop 23.0 or later and an RGB document with an
alpha-bearing image layer.
