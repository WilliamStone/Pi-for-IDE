# Pi for IDE / Pi Web+

[English](./README.md) | [中文](./README.zh-CN.md) | [Русский](./README.ru.md)

[pi エージェント](https://github.com/earendil-works/pi) の Web UI を VSCode/VSCodium に `pi-for-ide` 拡張機能として組み込み、IDE ワークフロー向けの統合層を重ねたプロジェクト。

- **`pi-for-ide`**（VSCode 拡張機能）：本体。pi-web サーバーを起動・接続する軽量ホストシェル。
- **`pi-web-for-ide`**（npm パッケージ）：下地。pi-web + IDE 適応層。ブラウザでは **Pi Web+** として独立動作し、`?embed=<host>` で埋め込むと **pi for IDE** モードに切り替わります。CLI: `pi-web`。

上流：[pi-web](https://github.com/agegr/pi-web)（agegr、Web UI 本体）、[pi-code](https://github.com/wangjinxin613/pi-code)（wangjinxin613、IDE 統合の起源）。

詳細は英語版 [README.md](./README.md) または中文版 [README.zh-CN.md](./README.zh-CN.md) をご覧ください。
