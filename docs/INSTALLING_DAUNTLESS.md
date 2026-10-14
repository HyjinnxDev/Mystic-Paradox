# Installing Dauntless 1.14.7

Mystic Paradox needs the Windows client of Dauntless 1.14.7 (`rel-1.14.7-Archon`, changelist `647472`).
The project does not host, mirror or distribute any game files. This guide downloads the build from Epic's own
servers to your PC with **your own Epic account**, using the open-source launcher
[Legendary](https://github.com/legendary-gl/legendary).

> [!IMPORTANT]
> This only works if Dauntless is in your Epic Games library, that is, if your account added it before the game
> left the store in May 2025. It can no longer be added. If Dauntless is not in your library, this guide cannot
> help, and the project cannot provide the game.

> [!NOTE]
> Legendary is an external, third-party tool. It is not made, maintained or reviewed by Mystic Paradox, and this
> guide uses it only as one example. Any similar tool that can install an Epic build from a manifest works too, as
> long as it uses the manifest from this guide and the result passes the checks in [step 5](#5-check-the-result).
> Mystic Paradox takes no responsibility for Legendary or any other third-party tool, for how it handles your
> files or your Epic account, or for the results of using it. You use these tools at your own risk.

## Why not just press Install?

Epic still lists Dauntless for accounts that own it, but the build it serves today is **2.1.1** (Awakening).
The Epic Games Launcher, Heroic and a plain `legendary install` all download 2.1.1, which Mystic Paradox does not
support. To get 1.14.7 you give Legendary that build's *manifest*: a small file (about 1 MB) listing the pieces of
the game that Epic's servers should send. Epic only hands out the manifest for its current build. The 1.14.7
manifest was preserved by the community
[Dauntless Manifest Archive](https://github.com/addison2k/DauntlessManifestArchive); Mystic Paradox serves a
checked copy of it. The manifest contains no game content, and the game itself still comes from Epic.

## What you need

- Windows 10 or 11, 64-bit.
- An Epic account with Dauntless in its library.
- About 17 GB free on the drive you install to: the download is 14.9 GiB and the installed game 15.4 GiB.
- Legendary 0.21.1 or newer.

## 1. Get Legendary

Download `legendary_windows_x64.exe` from the
[Legendary releases page](https://github.com/legendary-gl/legendary/releases/latest), put it in a folder of its
own, for example `D:\Tools\Legendary`, and rename it to `legendary.exe`.

Open PowerShell in that folder: open the folder in File Explorer, click the address bar, type `powershell` and
press Enter. Check that Legendary runs:

    .\legendary.exe --version

## 2. Sign in to Epic

    .\legendary.exe auth

A window opens on Epic's sign-in page. Sign in with the account that has Dauntless.

If no window appears, run `.\legendary.exe auth --disable-webview` instead. Your browser opens; after you sign in,
the page shows a short block of text containing an `authorizationCode`. Paste that code into PowerShell when
Legendary asks for it.

The authorization code signs in to your Epic account, so treat it like a password: never post it in an issue,
on Discord or anywhere else. Legendary keeps the session in `%USERPROFILE%\.config\legendary`;
[Signing out](#signing-out) removes it.

## 3. Check that Dauntless is in your library

Epic's internal name for Dauntless is `Jackal`.

    .\legendary.exe info Jackal

If it prints details about Dauntless, continue. It may name 2.1.1 as the current version; that is expected.
If it reports that the game cannot be found, Dauntless is not in this account's library and the next step will
not work.

## 4. Download 1.14.7

Replace `D:\Games` with the folder you want the game in. Legendary creates a `Dauntless` folder inside it.

    .\legendary.exe install Jackal --manifest "https://api.mysticfox.dev/v2/Dauntless_1.14.7.647472.manifest" --base-url "https://egs-cloudfront-chunks.epicgamescdn.com/Builds/Org/o-krlzxj88qrtb69fredeuaf887bl5az/Jackal/default" --base-path "D:\Games" --skip-sdl

Legendary prints the install path and the sizes (about 15,245 MiB to download, 15,756 MiB installed) and asks
whether to continue. Type `y` and press Enter.

- `--manifest` selects build 1.14.7. Do not swap it for a manifest from anywhere else: a manifest decides which
  files are written and what they contain.
- `--base-url` is Epic's download server for Dauntless, the same location Epic's own servers give Legendary for
  the game. It is the same for every build of the game.

If the download is interrupted, run the same command again. Legendary continues where it stopped.

**Optional: check the manifest first.** Download it, compare its SHA-1 with the value below, and give Legendary
the file instead of the link:

    Invoke-WebRequest -Uri https://api.mysticfox.dev/v2/Dauntless_1.14.7.647472.manifest -OutFile Dauntless_1.14.7.647472.manifest
    Get-FileHash -Algorithm SHA1 -LiteralPath .\Dauntless_1.14.7.647472.manifest

The hash must be `AA70748E4C0A776A991F2BAC10AD342ADAA31476`. Then use `--manifest ".\Dauntless_1.14.7.647472.manifest"`
in the install command.

## 5. Check the result

    .\legendary.exe verify Jackal

Legendary re-reads every file and compares it with the manifest. It should say it is verifying version
`1.14.7.647472` and end with `Verification finished successfully.`

Then confirm that the game executable is the supported one:

    Get-FileHash -Algorithm SHA256 -LiteralPath 'D:\Games\Dauntless\Archon\Binaries\Win64\Dauntless-Win64-Shipping.exe'

| Check | Expected value |
|---|---|
| `Archon\Binaries\Win64\Dauntless-Win64-Shipping.exe`, SHA-256 | `F3F95FBF22709EF077A11632ED95D675B7209B7E0172D9ECB9BA7D02A1FBB66B` |
| `Version.txt` in the `Dauntless` folder | `dauntless_rel-1.14.7_Shipping_2024-04-01_14-59-21_647472` |
| Number of game files | 611 |
| 1.14.7 manifest, SHA-1 | `aa70748e4c0a776a991f2bac10ad342adaa31476` |

## 6. Point the Mystic Paradox launcher at it

In the launcher, select **Locate game** and choose the `Dauntless` folder from step 4, for example
`D:\Games\Dauntless`. The launcher finds `Archon\Binaries\Win64\Dauntless-Win64-Shipping.exe` and checks its hash.

Always start the game from the Mystic Paradox launcher, not from Legendary, Heroic or the Epic Games Launcher.

## Keep it on 1.14.7

Anything that updates Dauntless replaces 1.14.7 with 2.1.1.

- Do not run `legendary update Jackal`, or `legendary install Jackal` without the `--manifest` option.
- Do not install, import or update Dauntless in Heroic or the Epic Games Launcher, and do not point them at
  this folder.
- `legendary list-installed --check-updates` reports an update for Dauntless. Ignore it.

If the game was updated by mistake, run the install command from step 4 again. Legendary downloads only the
files that differ and returns the folder to 1.14.7.

## Repairing

If game files are damaged or missing, repair against the same manifest and server:

    .\legendary.exe repair Jackal --manifest "https://api.mysticfox.dev/v2/Dauntless_1.14.7.647472.manifest" --base-url "https://egs-cloudfront-chunks.epicgamescdn.com/Builds/Org/o-krlzxj88qrtb69fredeuaf887bl5az/Jackal/default"

Repair checks every file and downloads only the bad ones. Never add `--repair-and-update`: it also updates the
game to 2.1.1.

## Troubleshooting

| Problem | What to do |
|---|---|
| `Could not find "Jackal" in list of available games` | Dauntless is not in the signed-in account's library. `.\legendary.exe status` shows which account is signed in. |
| `Login failed! Cannot continue with download process.` | Run `.\legendary.exe auth` again. |
| The download stopped or the window was closed | Run the same install command again. It resumes. |
| The download is very slow | Stop it with `Ctrl+C` and run the command again with another Epic host in `--base-url`: replace `https://egs-cloudfront-chunks.epicgamescdn.com` with `https://epicgames-download1.akamaized.net` or `https://egdownload.fastly-edge.com` and keep the rest of the address. |
| `403` or `404` errors on chunks | Epic has removed the 1.14.7 files from its servers, which it can do at any time. Please open an issue so this guide can be updated. |
| `verify` lists failed or missing files | Run the repair command above. |
| The launcher rejects the executable | Check its SHA-256 (step 5). Any other value is a different build or a modified file; run the repair command. |

## Dauntless 1.12.0

`main` targets 1.14.7. If you build the older
[`dauntless-1.12.0`](https://github.com/pranav158/Mystic-Paradox/tree/dauntless-1.12.0) tag instead, follow the same
steps with the 1.12.0 manifest, `https://api.mysticfox.dev/v2/Dauntless_1.12.0.392819.manifest`.

Legendary manages only one copy of `Jackal`. If it already installed 1.14.7, the install command ignores
`--base-path` and converts that folder to 1.12.0. To keep both versions, first make Legendary forget the 1.14.7
copy without deleting it, then install 1.12.0 with a different `--base-path`:

    .\legendary.exe uninstall Jackal --keep-files

Legendary can then verify and repair only the copy it installed last.

| Check | Expected value |
|---|---|
| Download / installed size | about 15,089 MiB / 15,661 MiB |
| `legendary verify Jackal` version | `1.12.0.392819` |
| `Archon\Binaries\Win64\Dauntless-Win64-Shipping.exe`, SHA-256 | `EE30D1821B4020FF1BCAA89A63FA6EF3515EFB622F2969546B91BF018A379F43` |
| `Version.txt` in the `Dauntless` folder | `dauntless_rel-1.12.0_Shipping_2022-10-03_14-36-04_392819` |
| Number of game files | 609 |
| 1.12.0 manifest, SHA-1 | `46b4097c070afc29ed783e77a68ffa936b6a3504` |

## Signing out

To remove the Epic session that Legendary saved:

    .\legendary.exe auth --delete

The installed game keeps working with the Mystic Paradox launcher without it. Repairs need you to sign in again.

## Credits

The 1.14.7 and 1.12.0 manifests were preserved by the
[Dauntless Manifest Archive](https://github.com/addison2k/DauntlessManifestArchive) (contributed by Moyka009 and
zgh95). [Legendary](https://github.com/legendary-gl/legendary) is an independent open-source Epic Games
launcher. Neither is affiliated with Mystic Paradox, and Mystic Paradox is not affiliated with Epic Games,
Phoenix Labs, Forte Labs or any current or former Dauntless rights holder. Third-party tools are used at your own
risk; see the note at the top of this guide.
