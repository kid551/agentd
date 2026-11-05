# agentd

在一个 Claude Code 会话（Router）里派工给多个后台 Worker，在一个面板里批阅它们的提问、权限请求和交付。

完整说明（架构、机制、配置、开发）见 [README.html](README.html)，下载后用浏览器打开。

## 安装

需要：Node ≥ 24、`git`、已登录的 Claude Code（`claude` 在 PATH 上）。目前只在 macOS 上验证过。

Router 要一个专用的空文件夹，下面用 `~/agentd-router`。不要放进代码仓库（原因见 README.html 6.4）。

```sh
mkdir -p ~/agentd-router/.claude && cd ~/agentd-router && touch .agentd-router
cat > .claude/settings.json <<'EOF'
{
  "extraKnownMarketplaces": {
    "kid551-agentd": {
      "source": { "source": "github", "repo": "kid551/agentd" },
      "autoUpdate": true
    }
  }
}
EOF
claude plugin install agentd-router --marketplace kid551/agentd --scope project
code .
```

在这个窗口里打开 Claude Code。第一次会问是否信任这个文件夹，选「是」。之后在这里说人话派工即可，例如「在 memos 里补上导出的单测」。要派工的项目默认从 `~/code` 下找，改法见 README.html 6.1。

`settings.json` 里的 `autoUpdate` 打开自动更新：第三方市场默认是关的。

## 更新

- **自动**：每次在 Router 文件夹里启动 Claude Code，都会在后台检查新版本，下次启动生效；想立刻生效就执行 `/reload-plugins`。如果 Router 提示守护进程过期，执行 `/agentd restart`。
- **手动**：

  ```sh
  claude plugin marketplace update kid551-agentd
  cd ~/agentd-router && claude plugin update agentd-router@kid551-agentd --scope project
  ```

2026-11-05 前按旧名 `TerenceXie-agentd` 装过的：先执行 `claude plugin marketplace remove TerenceXie-agentd`，再按上面的安装步骤重装（`.claude/settings.json` 会被覆盖成新名字）。

## 卸载

```sh
cd ~/agentd-router && claude plugin uninstall agentd-router@kid551-agentd --scope project
claude plugin marketplace remove kid551-agentd
curl -s -X POST http://127.0.0.1:7707/shutdown
```

## 贡献

这是公开仓库。提交前请读 [AGENTS.md](AGENTS.md)：`pnpm install` 会装上 pre-commit hook，它会拒绝密钥、个人邮箱、本机路径和内网地址。

## 许可证

MIT，见 [LICENSE](LICENSE)。
