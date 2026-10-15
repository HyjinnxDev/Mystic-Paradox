/*
 * Copyright (C) 2026 Hyjinnx (Dauntless Forever)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// [forever-discord] Issue tickets on the announcements bot (same DISCORD_NEWS_BOT_TOKEN as routes/news.ts).
// /issue title description   - anyone, only in channels added with /issue-channel; posts "#<id> <title>".
// /close id [reason]         - Manage Messages by default; marks the ticket closed and edits its post.
// /issue-channel add|remove|log|list - Manage Server by default. log = where tickets are posted (the reporter
// gets a private "logged as #id"); unset = posted where /issue was used.
// Server admins can retarget those defaults in Server Settings > Integrations. DISCORD_GUILD_ID set =
// commands registered in that server (instant); unset = global (up to an hour to appear).

import {
    ChannelType, Client, Events, GatewayIntentBits, InteractionContextType, MessageFlags, PermissionFlagsBits,
    SlashCommandBuilder, type APIEmbed, type APIEmbedField, type ChatInputCommandInteraction,
} from "discord.js";
import { logger } from "./logger";
import { GetMongoDb } from "./persistence/mongo/client";

export interface IssueDoc {
    _id: number;
    title: string;
    description: string;
    reporterId: string;
    channelId: string;
    messageId?: string;
    status: "open" | "closed";
    createdAt: Date;
    closedBy?: string;
    closeReason?: string | null;
    closedAt?: Date;
}

// _id "counter" holds the next ticket number, _id "channels" the allowed command channels + the log channel.
interface IssueConfigDoc { _id: string; next?: number; channels?: string[]; log?: string }

const ChannelOption = (o: any) => o.setName("channel").setDescription("Text channel").setRequired(true).addChannelTypes(ChannelType.GuildText);
const Commands = [
    new SlashCommandBuilder().setName("issue").setDescription("Report an issue")
        .addStringOption((o) => o.setName("title").setDescription("Short summary").setRequired(true).setMaxLength(200))
        .addStringOption((o) => o.setName("description").setDescription("What happened and how to reproduce it").setRequired(true).setMaxLength(3500)),
    new SlashCommandBuilder().setName("close").setDescription("Close an issue ticket")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addIntegerOption((o) => o.setName("id").setDescription("Ticket number").setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName("reason").setDescription("Resolution note").setMaxLength(500)),
    new SlashCommandBuilder().setName("issue-channel").setDescription("Choose where /issue is allowed")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((s) => s.setName("add").setDescription("Allow /issue in a channel").addChannelOption(ChannelOption))
        .addSubcommand((s) => s.setName("remove").setDescription("Stop allowing /issue in a channel").addChannelOption(ChannelOption))
        .addSubcommand((s) => s.setName("log").setDescription("Post issue tickets in this channel instead of where /issue was used").addChannelOption(ChannelOption))
        .addSubcommand((s) => s.setName("list").setDescription("Show channels that allow /issue")),
].map((c) => c.setContexts(InteractionContextType.Guild).toJSON());

export function IssueEmbed(Issue: IssueDoc): APIEmbed {
    const Closed = Issue.status === "closed";
    const Fields: APIEmbedField[] = [
        { name: "Status", value: Closed ? "Closed" : "Open", inline: true },
        { name: "Reported by", value: `<@${Issue.reporterId}>`, inline: true },
    ];
    if (Closed) Fields.push({ name: "Closed by", value: `<@${Issue.closedBy}>`, inline: true });
    if (Issue.closeReason) Fields.push({ name: "Resolution", value: Issue.closeReason });
    return {
        title: `#${Issue._id} ${Issue.title}`,
        description: Issue.description,
        color: Closed ? 0x747f8d : 0xe67e22,
        fields: Fields,
        timestamp: Issue.createdAt.toISOString(),
    };
}

async function Cols() {
    const Db = await GetMongoDb();
    return { Issues: Db.collection<IssueDoc>("discord_issues"), Config: Db.collection<IssueConfigDoc>("discord_issue_config") };
}

const ChannelList = (Ids: string[]) => Ids.map((Id) => `<#${Id}>`).join(", ");

async function Handle(I: ChatInputCommandInteraction): Promise<unknown> {
    const C = await Cols();
    const Whisper = (content: string) => I.reply({ content, flags: MessageFlags.Ephemeral });
    const Channels = await C.Config.findOne({ _id: "channels" });
    const Allowed = Channels?.channels ?? [];
    const LogId = Channels?.log;

    if (I.commandName === "issue") {
        if (!Allowed.includes(I.channelId)) {
            return Whisper(Allowed.length ? `Issues can't be reported here. Use ${ChannelList(Allowed)}.` : "Issue reporting isn't set up yet.");
        }
        const Counter = await C.Config.findOneAndUpdate({ _id: "counter" }, { $inc: { next: 1 } }, { upsert: true, returnDocument: "after" });
        const Issue: IssueDoc = {
            _id: Counter!.next!, title: I.options.getString("title", true), description: I.options.getString("description", true),
            reporterId: I.user.id, channelId: LogId ?? I.channelId, status: "open", createdAt: new Date(),
        };
        await C.Issues.insertOne(Issue);
        if (!LogId) {
            const Res = await I.reply({ embeds: [IssueEmbed(Issue)], withResponse: true });
            return C.Issues.updateOne({ _id: Issue._id }, { $set: { messageId: Res.resource!.message!.id } });
        }
        try {
            const Post = await ((await I.client.channels.fetch(LogId)) as any).send({ embeds: [IssueEmbed(Issue)] });
            await C.Issues.updateOne({ _id: Issue._id }, { $set: { messageId: Post.id } });
        } catch (error) {
            await C.Issues.deleteOne({ _id: Issue._id }); // no post = no ticket; the reporter gets the error reply
            throw error;
        }
        return Whisper(`Thanks! Logged as issue #${Issue._id} in <#${LogId}>.`);
    }

    if (I.commandName === "close") {
        const Id = I.options.getInteger("id", true);
        const Issue = await C.Issues.findOneAndUpdate({ _id: Id, status: "open" },
            { $set: { status: "closed", closedBy: I.user.id, closeReason: I.options.getString("reason"), closedAt: new Date() } },
            { returnDocument: "after" });
        if (!Issue) return Whisper(await C.Issues.countDocuments({ _id: Id }) ? `Issue #${Id} is already closed.` : `There is no issue #${Id}.`);
        const Updated = await I.client.channels.fetch(Issue.channelId)
            .then((Ch) => (Ch as any).messages.edit(Issue.messageId, { embeds: [IssueEmbed(Issue)] }))
            .then(() => true, (error) => { logger.warn(`[Issues] post for #${Id} not updated: ${error}`); return false; });
        return Whisper(`Closed issue #${Id}: ${Issue.title}${Updated ? "" : " (original post could not be updated)"}`);
    }

    if (I.commandName === "issue-channel") {
        const Sub = I.options.getSubcommand();
        if (Sub === "list") {
            return Whisper((Allowed.length ? `/issue is allowed in ${ChannelList(Allowed)}.` : "/issue isn't allowed in any channel yet.")
                + (LogId ? ` Tickets are posted in <#${LogId}>.` : " Tickets are posted where /issue is used."));
        }
        const Id = I.options.getChannel("channel", true).id;
        if (Sub === "log") {
            await C.Config.updateOne({ _id: "channels" }, { $set: { log: Id } }, { upsert: true });
            return Whisper(`New issue tickets will be posted in <#${Id}>. Existing tickets stay where they are.`);
        }
        await C.Config.updateOne({ _id: "channels" }, Sub === "add" ? { $addToSet: { channels: Id } } : { $pull: { channels: Id } }, { upsert: true });
        return Whisper(`/issue is ${Sub === "add" ? "now allowed" : "no longer allowed"} in <#${Id}>.`);
    }
}

let IssueClient: Client | undefined;

// No token = feature off. Failures here only lose /issue, never the API.
export function StartDiscordIssues(): void {
    const Token = process.env.DISCORD_NEWS_BOT_TOKEN?.trim();
    if (!Token) return;
    const GuildId = process.env.DISCORD_GUILD_ID?.trim() || undefined;
    IssueClient = new Client({ intents: [GatewayIntentBits.Guilds] });
    IssueClient.once(Events.ClientReady, async (Ready) => {
        try {
            // create() upserts by name, so the bot's other commands are left alone.
            for (const Command of Commands) await Ready.application.commands.create(Command, GuildId);
            logger.info(`[Issues] /issue ready as ${Ready.user.tag}`);
        } catch (error) {
            logger.warn(`[Issues] command registration failed: ${error}`);
        }
    });
    IssueClient.on(Events.InteractionCreate, async (I) => {
        if (!I.isChatInputCommand()) return;
        try { await Handle(I); } catch (error) {
            logger.error(`[Issues] /${I.commandName} failed: ${error}`);
            const Msg = { content: "Something went wrong. Please try again.", flags: MessageFlags.Ephemeral } as const;
            await (I.replied || I.deferred ? I.followUp(Msg) : I.reply(Msg)).catch(() => {});
        }
    });
    IssueClient.login(Token).catch((error) => logger.warn(`[Issues] Discord login failed: ${error}`));
}

export async function StopDiscordIssues(): Promise<void> {
    await IssueClient?.destroy();
}
