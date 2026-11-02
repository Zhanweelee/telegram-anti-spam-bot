---
"@tasb/detector-link": minor
---

带协议的主机名不再把多字节百分号编码收成同一个地址。`http://b%E2%85%A0t.ly` 留着。`http://b%69t.ly` 仍按短链删除。路径不进证据。
