---
"@tasb/worker": minor
---

可选绑定 `RATE_WINDOW` 之后，同一群的洪泛和重复计数能跨 isolate 累加。没绑定时仍用内存。
