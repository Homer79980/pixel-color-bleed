# 颜色像素扩散 / Pixel Color Bleed for Photoshop

## 中文

这是一个完全开源的 Adobe Photoshop UXP 插件。它会沿图像的局部颜色结构向透明区域扩展实心、不透明像素，同时保持原图层不变。

适用场景包括 UI 资源、游戏图标、Sprite 和需要扩展轮廓边缘的透明图片。

### 仓库内容

- `source/photoshop/pixel-color-bleed-plugin/`：Photoshop UXP 插件源码和图标。
- `releases/0.1.0/`：0.1.0 版本的发布说明。
- GitHub Release：提供可直接安装的 `.ccx` 插件包。

### 安装插件

1. 打开 [v0.1.0 Release](https://github.com/Homer79980/pixel-color-bleed/releases/tag/v0.1.0)。
2. 下载 `pixel-color-bleed-0.1.0.ccx`。
3. 在 Photoshop 的插件管理中安装 `.ccx` 文件。
4. 从“插件”菜单打开“颜色像素扩散”面板。
5. 选择一个带透明度的 RGB 图像图层并执行生成。

插件会在原图层下方创建新的扩展图层，原图层不会被修改。

### 参数

- 扩展像素：向外扩展的像素半径。
- 色相：`-180` 到 `180`。
- 饱和度：`-100` 到 `100`。
- 明度：`-100` 到 `100`。
- 自动扩展画布：默认关闭；需要避免文档边界裁切时再开启。

颜色融合始终开启。色相、饱和度和明度只作用于生成的扩展像素，并且每项都支持滑块和手动输入数值。

### 开发加载

插件需要 Photoshop 23.0 或更高版本，并要求文档为 RGB、图层带透明度。

1. 在 Photoshop 中开启开发者模式。
2. 选择“插件 > 开发 > 加载未签名插件”。
3. 选择 `source/photoshop/pixel-color-bleed-plugin/` 文件夹。

检查主脚本：

```text
node --check source/photoshop/pixel-color-bleed-plugin/main.js
```

## English

This is a fully open-source Adobe Photoshop UXP plugin. It extends a
transparent image with solid, opaque pixels guided by local color structure,
without modifying the original layer.

It is intended for UI assets, game icons, sprites, and transparent artwork
that needs extra pixels around its silhouette.

### Repository contents

- `source/photoshop/pixel-color-bleed-plugin/`: Photoshop UXP source and icons.
- `releases/0.1.0/`: release notes for version 0.1.0.
- `releases/0.1.1/`: release notes for version 0.1.1.
- GitHub Releases: downloadable `.ccx` plugin packages.

### Install

1. Open the [v0.1.1 Release](https://github.com/Homer79980/pixel-color-bleed/releases/tag/v0.1.1).
2. Download `pixel-color-bleed-0.1.1.ccx`.
3. Install the `.ccx` file through Photoshop plugin management.
4. Open the `Color Pixel Bleed` panel from the Plugins menu.
5. Select an RGB image layer with transparency and run the panel.

The plugin creates a new extension layer below the source layer. The original
artwork remains unchanged.

### Controls

- Extension pixels: outward extension radius in pixels.
- Hue: `-180` to `180` degrees.
- Saturation: `-100` to `100`.
- Lightness: `-100` to `100`.
- Expand canvas: disabled by default; enable it when document bounds would
  otherwise clip the generated pixels.

Color fusion is always enabled. Hue, saturation, and lightness affect only
generated extension pixels, and each control supports both a slider and direct
numeric input.

### Development

The plugin requires Photoshop 23.0 or later and an RGB document with an
alpha-bearing image layer.

1. Enable Photoshop developer mode.
2. Choose `Plugins > Development > Load Unsigned Plugin`.
3. Select `source/photoshop/pixel-color-bleed-plugin/`.

Check the main script with:

```text
node --check source/photoshop/pixel-color-bleed-plugin/main.js
```

## License / 许可证

MIT License. See `LICENSE`.
