---
"@tasb/platform-telegram": minor
---

隐藏草稿在带协议主机名末尾的连字符后面、文字字母紧接着 `@` 时停住。没有协议时这段字母仍删掉。`http://bit.ly-α/…` 留着。`http://bit.ly-α@evil.com/…` 仍按短链删除。路径不进证据。
