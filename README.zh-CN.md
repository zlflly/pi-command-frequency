# pi-command-frequency

给 Pi 的 `/` 命令补全增加自动使用频率排序。完全本地，不调用 AI、不消耗 token、不联网、不使用 SQLite，也没有运行时依赖。

## 安装

本地目录：

```sh
pi install /绝对路径/pi-command-frequency
```

GitHub 仓库发布后：

```sh
pi install git:github.com/zlflly/pi-command-frequency
```

npm 发布后：

```sh
pi install npm:pi-command-frequency
```

安装后执行 `/reload` 或重启 Pi。已在 Pi 1.0.0、Node 26 上测试；包要求 Node ≥22.19。

## 排序规则

- 输入 `/`：使用次数多的排前面；次数相同则最近使用的优先；再相同则保留 Pi 原顺序。
- 输入 `/关键词`：精确匹配优先，其次前缀匹配、其他模糊匹配；每类内部按次数和最近使用时间排序。
- 只有在主编辑器实际提交的命令才会计数，单纯选择补全、按 Tab 不计数。
- 支持内置命令、扩展命令、提示词模板和 `/skill:name`；不维护容易过时的内置命令列表。
- 保留 Pi 原有参数补全、文件补全、取消信号、补全插入行为和快捷键。
- 跨项目、跨会话保存统计；支持同一机器多个 Pi 进程追加记录。
- 无效命令、普通聊天和管理命令自身不计数。取消或执行失败的命令仍按一次提交计算。

管理命令：

```text
/command-frequency        显示前 15 个命令及次数
/command-frequency stats
/command-frequency reset  确认后清零计数
```

## 数据与隐私

默认保存到：

```text
~/.pi/agent/data/pi-command-frequency/usage.jsonl
```

支持 `PI_CODING_AGENT_DIR`。仅记录命令名和时间，不记录参数、聊天文本、文件内容或凭据。新目录/文件权限分别为 `0700`/`0600`。损坏记录会被忽略；读写失败只警告一次，不影响命令执行。

日志采用追加写入，避免多进程覆盖计数；适用于本地文件系统。每次提交约增加 50–200 字节，不自动压缩。`reset` 写入清零标记，不删除旧记录。彻底清除历史命令名和时间需先关闭全部 Pi，再删除该日志。

## 限制

此扩展通过公开接口替换主编辑器。同一时间只有一个自定义编辑器生效，与 Vim/ghost-text 等替换编辑器的扩展可能冲突，后安装的编辑器会覆盖前者。

只在终端交互模式工作，不修改 print/JSON/RPC 行为；不会扫描历史会话，也不统计命令行初始提示或程序发送的命令。安装后从零开始学习。

完整开发及发布说明见 [English README](README.md)。MIT 许可。
