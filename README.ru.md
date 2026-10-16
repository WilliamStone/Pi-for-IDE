# Pi for IDE / Pi Web+

[English](./README.md) | [中文](./README.zh-CN.md) | [日本語](./README.ja.md)

Встраивает веб-интерфейс [агента pi](https://github.com/earendil-works/pi) в VSCode/VSCodium через расширение `pi-for-ide` с интеграционным слоем для IDE-задач.

- **`pi-for-ide`** (расширение VSCode): основной продукт. Лёгкая оболочка, запускающая/подключающая pi-web сервер.
- **`pi-web-for-ide`** (npm-пакет): основа. pi-web + слой адаптации под IDE. В браузере работает как **Pi Web+**, при встраивании через `?embed=<host>` переключается в режим **pi for IDE**. CLI: `pi-web`.

Апстримы: [pi-web](https://github.com/agegr/pi-web) (agegr, сам веб-интерфейс), [pi-code](https://github.com/wangjinxin613/pi-code) (wangjinxin613, первоисточник IDE-интеграции).

Подробности см. в [README.md](./README.md) (англ.) или [README.zh-CN.md](./README.zh-CN.md) (кит.).
