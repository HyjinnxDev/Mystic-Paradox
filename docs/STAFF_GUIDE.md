# Staff guide

The server's moderation and admin tools live at **`https://<server>/admin/`**. If the server uses a pinned self-signed certificate, the browser shows a certificate warning; accept it. On the host machine itself, `http://127.0.0.1:3000/admin/` also works.

## Roles

| Can do | Moderator | Admin | Owner |
|---|:-:|:-:|:-:|
| See players, who's online, audit log | ✓ | ✓ | ✓ |
| Timed ban, up to 7 days | ✓ | ✓ | ✓ |
| Longer or permanent ban, unban, disable | | ✓ | ✓ |
| Approve or reject sign-ups | | ✓ | ✓ |
| Grant or remove moderator, admin, tester | | | ✓ |
| Delete an account, change operations policy | | | ✓ |

- Staff can only act on accounts **below** their own role. A moderator can't ban another moderator or an admin, and nobody can change their own role.
- **Owner** can't be granted from the website. Only the bootstrap script on the server machine can grant it (see below).

## Signing in

- Staff sign in with their **launcher username** (or email) and launcher password.
- Discord sign-in only works for Discord IDs listed in `ADMIN_DISCORD_ALLOWED_IDS`. It needs `ADMIN_FRONTEND_URL` and `ADMIN_DISCORD_REDIRECT_URI` to point at this server's `/admin/` and `/admin/v1/auth/discord/callback`.
- If `ADMIN_TOTP_SECRET` is set, password sign-in also needs an authenticator code. That secret is **shared by all staff**, so only set it if everyone with staff access can be given the same code.

## What a ban does

When you ban or disable someone, the following happens straight away:

1. Their launcher sign-in stops working. A timed ban tells them when it ends.
2. Every game API request they make fails, so they can't load into a new map or hunt.
3. They're disconnected from chat (XMPP), and reconnecting is refused.
4. They're dropped from party voice within about 15 seconds.

**Not covered yet:** the game server can't kick them. They stay in the map they're already in until they travel, and then they can't get back in.

A timed ban ends by itself, so nobody has to lift it. Every access change needs a reason, and the reason shows in the audit log and in the player's history.

## Which action to use

- **Timed ban:** behaviour problems (harassment, griefing, spam). Start short and go longer for repeat offences.
- **Permanent ban:** cheating, exploits that damage other players, or serious harassment. Admin only.
- **Disable:** not a punishment. Use it to pause an account, for example a compromised account or a player who asked for it.
- **Reject sign-up:** an access request you don't want to accept.

## Setting up the first owner (server operator)

On the server machine, from `ParadoxBackend`:

```
npm run admin:bootstrap -- --email=you@example.com --username=YourLauncherName --confirm=GRANT_ADMIN_ROLE
```

This gives that launcher account the `owner` and `admin` roles. From then on, grant moderators and admins from the dashboard: **Players → click the player → Roles**.
