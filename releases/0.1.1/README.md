# 颜色像素扩散 0.1.1 / Pixel Color Bleed 0.1.1

## 中文

这是 0.1.1 版本的 Photoshop UXP 插件发布说明。

本版本修复了部分 Photoshop/UXP 环境中滑块启动后被拉到最小或最大值、拖动不连续的问题。滑块内部改用稳定的非负坐标，界面上的色相、饱和度和明度数值范围保持不变，并在面板加载时强制同步。

安装方式：

1. 下载 GitHub Release 中的 `pixel-color-bleed-0.1.1.ccx`。
2. 使用 Photoshop 的插件管理安装 `.ccx` 文件。
3. 在“插件”菜单中打开“颜色像素扩散”。

## English

This is the Photoshop UXP plugin release for version 0.1.1.

This release fixes an issue on some Photoshop/UXP installations where the adjustment sliders initialized at an endpoint and could not be dragged smoothly. The native sliders now use stable non-negative coordinates while the displayed hue, saturation, and lightness ranges remain unchanged. The controls are also explicitly synchronized when the panel loads.

Installation:

1. Download `pixel-color-bleed-0.1.1.ccx` from the GitHub Release.
2. Install the `.ccx` file through Photoshop plugin management.
3. Open `Color Pixel Bleed` from the Plugins menu.
