# 颜色像素扩散 / Pixel Color Bleed UXP Plugin

## 中文

这是一个 Photoshop UXP 面板。插件会在选中图层下方生成新的像素图层，沿局部颜色结构向外扩展实心、不透明像素，不需要重复复制和合并 Photoshop 图层。

功能：

- 生成区域使用完全不透明像素。
- 结构引导的波前扩展，让颜色带沿局部轮廓继续延伸。
- 根据图像内部颜色边界估计走势，并在轮廓边缘平滑引导方向。
- 使用旋转邻域采样，保持扩展颜色的融合感。
- 使用少量内侧重叠，减少源图层与扩展层之间的透明缝隙。
- 颜色融合始终开启，不再提供融合滑块。
- 色相、饱和度、明度均支持滑块和手动数值输入。
- 自动扩展画布默认关闭，可按需开启。
- 原图层保持不变。

### 开发加载

1. 在 Photoshop 中开启“插件 > 开发 > 开发者模式”。
2. 选择“插件 > 开发 > 加载未签名插件”。
3. 选择当前文件夹 `pixel-color-bleed-plugin`。
4. 从“插件”菜单打开“颜色像素扩散”面板。

需要 Photoshop 23.0 或更高版本，并要求使用带透明度的 RGB 图像图层。

## English

This Photoshop UXP panel creates a new pixel layer below the selected layer.
It extends the artwork outward with solid, opaque pixels guided by local
color structure, without repeatedly duplicating and merging Photoshop layers.

Features:

- Fully opaque pixels in the generated region.
- Structure-guided wavefront extension that continues color bands along local
  contours.
- Source-only color-boundary guidance with smoothed edge directions.
- Rotated neighborhood sampling to preserve blended color appearance.
- A small inward overlap to reduce transparent seams at the source boundary.
- Color fusion is always enabled; there is no blend slider.
- Hue, saturation, and lightness support both sliders and numeric input.
- Canvas expansion is optional and disabled by default.
- The original artwork layer remains unchanged.

### Development loading

1. Enable `Plugins > Development > Enable Developer Mode` in Photoshop.
2. Choose `Plugins > Development > Load Unsigned Plugin...`.
3. Select this `pixel-color-bleed-plugin` folder.
4. Open the `Color Pixel Bleed` panel from the Plugins menu.

Photoshop 23.0 or later is required. The document must be RGB and the image
layer must contain transparency.
