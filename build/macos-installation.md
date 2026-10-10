### macOS 安装说明（Apple Silicon）

当前 DMG 适用于 Apple Silicon（M 系列芯片）。应用使用无需开发者证书的 **ad-hoc 签名**，没有 Developer ID 签名或 Apple 公证，首次打开仍可能被 macOS 门禁拦截。签名完整性检查通过不代表 macOS 会自动允许打开，也不代表功能已经测试通过。

1. 打开 DMG，将 **GPT Web to Codex Terminal.app** 拖入“应用程序”目录；更新时覆盖旧应用。
2. 从“应用程序”打开。若提示无法验证开发者，进入 **系统设置 → 隐私与安全性 → 仍要打开**，再确认“打开”。
3. 若仍提示“已损坏，无法打开”，且确认安装包来自本仓库的 GitHub Release，可在“终端”执行以下命令，移除本应用的下载隔离标记，再手动打开：

   ```bash
   xattr -dr com.apple.quarantine "/Applications/GPT Web to Codex Terminal.app"
   ```

   如果应用安装在其他位置，将命令中的路径替换为实际 `.app` 路径。命令需要对应用目录的写入权限。若仍无法打开，请保留提示信息并反馈；此步骤不能修复实际损坏的文件。

若要让公开下载的安装包按 Apple 的默认门禁策略打开，后续需配置 Developer ID 签名和 Apple 公证。详见 [Apple：在 Mac 上安全地打开 App](https://support.apple.com/zh-cn/102445) 和 [electron-builder：macOS 签名](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/)。

### macOS installation (Apple Silicon)

The DMG supports Apple Silicon (M-series Macs). The app is **ad-hoc signed** without a Developer ID certificate or Apple notarization, so Gatekeeper may still block its first launch. Package integrity checks do not establish Gatekeeper trust or verify app functionality.

1. Open the DMG and drag **GPT Web to Codex Terminal.app** into **Applications**, replacing the previous app when updating.
2. Open it from Applications. If macOS cannot verify the developer, go to **System Settings → Privacy & Security → Open Anyway**, then confirm **Open**.
3. If macOS still reports that the app is damaged, and you downloaded it from this repository's GitHub Release, remove this app's download quarantine attribute in Terminal, then open it manually:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/GPT Web to Codex Terminal.app"
   ```

   Adjust the path if installed elsewhere. You need write permission to the app directory. If it still fails, report the message; removing quarantine cannot repair corrupted files.

Developer ID signing and Apple notarization are required for public downloads to meet Apple's default Gatekeeper policy. See [Apple's guidance](https://support.apple.com/en-us/102445) and [electron-builder's signing documentation](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/).
