#!/usr/bin/env python3
"""生成扩展图标 resources/icons/icon-128.png（pi for IDE：IDE 窗口 + π）。

设计：图标本体即一个编辑器窗口——圆角方块 = 窗口体（indigo→紫渐变），
顶部深色标题栏带三枚 macOS 风格交通灯 + 一条浅色"标签页"短条，
正文区居中白色 π。

用法（Windows，需 Pillow）：

    pip install pillow
    python vscode-extension/scripts/generate-icon.py

可调参数集中在下方常量区；文件实际输出 256x256（商店要求 >=128）。
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SIZE = 256          # 输出像素
SS = 4              # 超采样倍率（抗锯齿）
INSET = 8           # 内容距画布边缘（px，@256）
CORNER = 30         # 圆角半径（px，@256）
TITLE_H = 52        # 标题栏高度（px，@256）
DOT_R = 9           # 交通灯半径
DOT_X0, DOT_DX = 38, 30  # 交通灯起始 x / 间距
TAB_X0, TAB_X1 = 150, 208  # 标题栏右侧"标签页"短条范围
TAB_H = 5           # 短条半高
PI_FONT = "C:/Windows/Fonts/seguisb.ttf"  # Segoe UI Semibold；Linux 换 DejaVu Sans Bold
PI_SIZE = 146       # π 字号（px，@256）
PI_LIFT = 8 + 20    # π 相对正文中心上移量（px，@256）
C_TOP = (99, 102, 241)    # 渐变顶色 #6366F1
C_BOT = (139, 92, 246)    # 渐变底色 #8B5CF6

OUT = Path(__file__).resolve().parent.parent / "resources" / "icons" / "icon-128.png"


def main() -> None:
    w = SIZE * SS
    s = lambda v: v * SS  # noqa: E731

    # 1) 方形底：垂直渐变 + 全部图形
    base = Image.new("RGBA", (w, w))
    gd = ImageDraw.Draw(base)
    for y in range(w):
        t = y / w
        gd.line(
            [(0, y), (w, y)],
            fill=tuple(int(C_TOP[i] + (C_BOT[i] - C_TOP[i]) * t) for i in range(3)) + (255,),
        )

    d = ImageDraw.Draw(base)

    # 标题栏深色横带（顶端到 TITLE_H+INSET）
    d.rectangle([0, 0, w, s(TITLE_H) + s(INSET)], fill=(24, 24, 50, 140))

    # 交通灯
    cy = (s(INSET) + s(TITLE_H)) // 2 + 4 * SS
    for i, c in enumerate([(255, 95, 86), (254, 188, 46), (40, 200, 64)]):
        cx = s(DOT_X0) + i * s(DOT_DX)
        d.ellipse([cx - s(DOT_R), cy - s(DOT_R), cx + s(DOT_R), cy + s(DOT_R)], fill=c + (255,))

    # 标题栏右侧"标签页"短条
    d.rounded_rectangle(
        [s(TAB_X0), cy - s(TAB_H), s(TAB_X1), cy + s(TAB_H)],
        radius=s(TAB_H),
        fill=(255, 255, 255, 60),
    )

    # π 居中于正文区并上移
    font = ImageFont.truetype(PI_FONT, s(PI_SIZE))
    body_cy = (s(INSET) + s(TITLE_H) + w - s(INSET)) // 2 - s(PI_LIFT)
    d.text((w // 2, body_cy), "\u03c0", font=font, fill=(255, 255, 255, 255), anchor="mm")

    # 2) 统一套圆角 mask（最后裁剪，避免多次 paste 抹掉内容）
    mask = Image.new("L", (w, w), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [s(INSET), s(INSET), s(SIZE - INSET), s(SIZE - INSET)],
        radius=s(CORNER),
        fill=255,
    )
    out = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    out.paste(base, (0, 0), mask)

    out.resize((SIZE, SIZE), Image.LANCZOS).save(OUT)
    print(f"saved {OUT}")


if __name__ == "__main__":
    main()
