# Build resources

`electron-builder` reads packaging assets from this folder (configured as
`directories.buildResources` in `electron-builder.yml`).

Drop these files here to customise the installer and app icon:

| File            | Used for                                              |
| --------------- | ----------------------------------------------------- |
| `icon.ico`      | Windows (256×256 or larger, multi-resolution)          |
| `icon.icns`     | macOS                                                  |
| `icon.png`      | Linux (512×512 recommended)                            |
| `background.png`| Optional DMG background                                |

If no icon is present, electron-builder falls back to the default Electron
icon and prints a warning — the build still succeeds.
