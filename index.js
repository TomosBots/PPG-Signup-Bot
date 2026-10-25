require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  AttachmentBuilder
} = require("discord.js");

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const DATA_DIR = process.env.DATA_DIR || "/data";
const DATA_FILE = path.join(DATA_DIR, "ppg-data.json");

const CAPACITY = 22;
const WAITLIST_CAPACITY = 5;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  throw new Error(
    "Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID environment variable."
  );
}

fs.mkdirSync(DATA_DIR, { recursive: true });

function readData() {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(DATA_FILE, "utf8")
    );

    return parsed && typeof parsed === "object"
      ? parsed
      : { events: {} };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { events: {} };
    }

    throw new Error(
      `Could not read ${DATA_FILE}: ${error.message}`
    );
  }
}

let db = readData();

if (!db.events || typeof db.events !== "object") {
  db = { events: {} };
}

function saveData() {
  const temp = `${DATA_FILE}.tmp`;

  fs.writeFileSync(
    temp,
    JSON.stringify(db, null, 2),
    { mode: 0o600 }
  );

  fs.renameSync(temp, DATA_FILE);
}

const makeId = () => crypto.randomBytes(4).toString("hex");

const short = (value, max = 80) =>
  String(value ?? "").trim().slice(0, max);

const eventTypes = [
  { name: "200 Sponty", value: "200 Sponty" },
  { name: "400 Gems", value: "400 Gems" },
  { name: "600 Gems", value: "600 Gems" },
  { name: "1K Gems", value: "1K Gems" }
];

function adminOnly(command) {
  return command.setDefaultMemberPermissions(
    PermissionFlagsBits.Administrator
  );
}

const commands = [
  adminOnly(
    new SlashCommandBuilder()
      .setName("ppg-create")
      .setDescription("Create a PPG event and its first wave.")
      .addStringOption(o =>
        o.setName("name")
          .setDescription("Event name")
          .setRequired(true)
          .setMaxLength(80))
      .addStringOption(o =>
        o.setName("type")
          .setDescription("Event type")
          .setRequired(true)
          .addChoices(...eventTypes))
      .addUserOption(o =>
        o.setName("host")
          .setDescription("Event host")
          .setRequired(true))
      .addUserOption(o =>
        o.setName("cohost1")
          .setDescription("First co-host")
          .setRequired(true))
      .addUserOption(o =>
        o.setName("cohost2")
          .setDescription("Second co-host")
          .setRequired(true))
      .addStringOption(o =>
        o.setName("date")
          .setDescription("Optional date/time")
          .setRequired(false)
          .setMaxLength(80))
  ),

  adminOnly(
    new SlashCommandBuilder()
      .setName("ppg-wave")
      .setDescription("Create another wave.")
      .addStringOption(o =>
        o.setName("event_id")
          .setDescription("Event ID")
          .setRequired(true))
      .addStringOption(o =>
        o.setName("name")
          .setDescription("Wave name")
          .setRequired(true)
          .setMaxLength(40))
  ),

  adminOnly(
    new SlashCommandBuilder()
      .setName("ppg-edit")
      .setDescription("Edit an event.")
      .addStringOption(o =>
        o.setName("event_id")
          .setDescription("Event ID")
          .setRequired(true))
      .addStringOption(o =>
        o.setName("name")
          .setDescription("New event name")
          .setRequired(false)
          .setMaxLength(80))
      .addStringOption(o =>
        o.setName("date")
          .setDescription("New date/time; use - to clear")
          .setRequired(false)
          .setMaxLength(80))
      .addUserOption(o =>
        o.setName("host")
          .setDescription("New host")
          .setRequired(false))
      .addUserOption(o =>
        o.setName("cohost1")
          .setDescription("New first co-host")
          .setRequired(false))
      .addUserOption(o =>
        o.setName("cohost2")
          .setDescription("New second co-host")
          .setRequired(false))
  ),

  ...["open", "close"].map(action =>
    adminOnly(
      new SlashCommandBuilder()
        .setName(`ppg-${action}`)
        .setDescription(`${action} signups for a wave.`)
        .addStringOption(o =>
          o.setName("event_id")
            .setDescription("Event ID")
            .setRequired(true))
        .addStringOption(o =>
          o.setName("wave_id")
            .setDescription("Wave ID")
            .setRequired(true))
    )
  ),

  adminOnly(
    new SlashCommandBuilder()
      .setName("ppg-end")
      .setDescription("Close all waves for an event.")
      .addStringOption(o =>
        o.setName("event_id")
          .setDescription("Event ID")
          .setRequired(true))
  ),

  adminOnly(
    new SlashCommandBuilder()
      .setName("ppg-delete")
      .setDescription("Permanently delete an event.")
      .addStringOption(o =>
        o.setName("event_id")
          .setDescription("Event ID")
          .setRequired(true))
      .addStringOption(o =>
        o.setName("confirm")
          .setDescription("Confirm deletion")
          .setRequired(true)
          .addChoices({
            name: "DELETE",
            value: "DELETE"
          }))
  ),

  adminOnly(
    new SlashCommandBuilder()
      .setName("ppg-add")
      .setDescription("Manually add an attendee.")
      .addStringOption(o =>
        o.setName("event_id")
          .setDescription("Event ID")
          .setRequired(true))
      .addStringOption(o =>
        o.setName("wave_id")
          .setDescription("Wave ID")
          .setRequired(true))
      .addUserOption(o =>
        o.setName("member")
          .setDescription("Discord member")
          .setRequired(true))
      .addStringOption(o =>
        o.setName("ign")
          .setDescription("Member's in-game name")
          .setRequired(true)
          .setMaxLength(50))
      .addStringOption(o =>
        o.setName("friend_ign")
          .setDescription("Optional friend's in-game name")
          .setRequired(false)
          .setMaxLength(50))
  ),

  ...["remove", "promote"].map(action =>
    adminOnly(
      new SlashCommandBuilder()
        .setName(`ppg-${action}`)
        .setDescription(`${action} an attendee.`)
        .addStringOption(o =>
          o.setName("event_id")
            .setDescription("Event ID")
            .setRequired(true))
        .addStringOption(o =>
          o.setName("wave_id")
            .setDescription("Wave ID")
            .setRequired(true))
        .addUserOption(o =>
          o.setName("member")
            .setDescription("Discord member")
            .setRequired(true))
    )
  ),

  ...["list", "waitlist", "attendance", "export", "panel"].map(action =>
    adminOnly(
      new SlashCommandBuilder()
        .setName(`ppg-${action}`)
        .setDescription(`Manage or view ${action}.`)
        .addStringOption(o =>
          o.setName("event_id")
            .setDescription("Event ID")
            .setRequired(true))
        .addStringOption(o =>
          o.setName("wave_id")
            .setDescription("Wave ID")
            .setRequired(true))
    )
  ),

  adminOnly(
    new SlashCommandBuilder()
      .setName("ppg-events")
      .setDescription("List all PPG events.")
  ),

  adminOnly(
    new SlashCommandBuilder()
      .setName("ppg-stats")
      .setDescription("Show PPG signup statistics.")
  )
].map(command => command.toJSON());

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});
function getEvent(eventId) {
  return db.events[eventId];
}

function getWave(eventId, waveId) {
  return getEvent(eventId)?.waves?.[waveId];
}

function totalSeats(wave) {
  return Object.values(wave.attendees).reduce(
    (sum, attendee) =>
      sum + 1 + (attendee.friendIgn ? 1 : 0),
    0
  );
}

function totalWaitingSeats(wave) {
  return wave.waitlist.reduce(
    (sum, attendee) =>
      sum + 1 + (attendee.friendIgn ? 1 : 0),
    0
  );
}

function hostIds(event) {
  return [
    event.hostId,
    event.cohost1Id,
    event.cohost2Id
  ];
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(
    PermissionFlagsBits.Administrator
  );
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function panelPayload(eventId, waveId) {
  const event = getEvent(eventId);
  const wave = getWave(eventId, waveId);
  const seats = totalSeats(wave);
  const attendees = Object.values(wave.attendees);

  const embed = new EmbedBuilder()
    .setColor(wave.open ? 0x238636 : 0x8b2635)
    .setTitle(`🎉 ${event.name} — ${wave.name}`)
    .setDescription(
      `**Type:** ${event.type}\n` +
      (event.dateText
        ? `**When:** ${event.dateText}\n`
        : "") +
      `**Host:** <@${event.hostId}>\n` +
      `**Co-hosts:** <@${event.cohost1Id}> and <@${event.cohost2Id}>\n\n` +
      `**Attendee places:** ${seats}/22\n` +
      `**Waiting list:** ${wave.waitlist.length} signup(s)\n` +
      `**Signups:** ${wave.open ? "🟢 OPEN" : "🔴 CLOSED"}\n\n` +
      "Press Sign Up and enter your IGN. You can optionally add one friend. Each person uses one attendee place."
    )
    .setFooter({
      text: `Event ID: ${eventId} • Wave ID: ${waveId}`
    });

  if (attendees.length) {
    const lines = attendees.map((a, i) =>
      `**${i + 1}.** <@${a.userId}> — ${a.ign}` +
      (a.friendIgn ? ` (+1: ${a.friendIgn})` : "")
    );

    embed.addFields({
      name: "📋 Confirmed attendees",
      value: lines.join("\n").slice(0, 1024)
    });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ppg:signup:${eventId}:${waveId}`)
      .setLabel("Sign Up")
      .setEmoji("📝")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!wave.open),

    new ButtonBuilder()
      .setCustomId(`ppg:cancel:${eventId}:${waveId}`)
      .setLabel("Cancel Signup")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!wave.open)
  );

  return {
    embeds: [embed],
    components: [row]
  };
}

async function refreshPanel(eventId, waveId) {
  const wave = getWave(eventId, waveId);

  if (!wave?.channelId || !wave?.messageId) return;

  try {
    const channel = await client.channels.fetch(wave.channelId);
    const message = await channel.messages.fetch(wave.messageId);

    await message.edit(panelPayload(eventId, waveId));
  } catch (error) {
    console.error(
      "Panel refresh failed:",
      error.message
    );
  }
}

async function postPanel(interaction, eventId, waveId) {
  const message = await interaction.channel.send(
    panelPayload(eventId, waveId)
  );

  const wave = getWave(eventId, waveId);

  wave.channelId = message.channelId;
  wave.messageId = message.id;

  saveData();
  return message;
}

function validHostTeam(host, c1, c2) {
  return new Set([host.id, c1.id, c2.id]).size === 3;
}

function createWave(name, channelId) {
  return {
    id: makeId(),
    name,
    open: true,
    attendees: {},
    waitlist: [],
    channelId,
    messageId: null,
    createdAt: new Date().toISOString()
  };
}

function entryFor(userId, ign, friendIgn, addedBy) {
  return {
    userId,
    ign: short(ign, 50),
    friendIgn: short(friendIgn, 50),
    addedBy,
    signedUpAt: new Date().toISOString()
  };
}

function seatsAvailable(wave, friendIgn) {
  const needed = friendIgn ? 2 : 1;
  return CAPACITY - totalSeats(wave) >= needed;
}

function enqueueOrConfirm(wave, entry) {
  const size = 1 + (entry.friendIgn ? 1 : 0);

  if (
    totalSeats(wave) + size <= CAPACITY &&
    wave.waitlist.length === 0
  ) {
    wave.attendees[entry.userId] = entry;
    return "confirmed";
  }

  if (
    totalWaitingSeats(wave) + size <= WAITLIST_CAPACITY * 2
  ) {
    wave.waitlist.push(entry);
    return "waitlist";
  }

  return "full";
}

function promoteWaiting(wave, userId) {
  const index = wave.waitlist.findIndex(
    attendee => attendee.userId === userId
  );

  if (index < 0) return false;

  const entry = wave.waitlist[index];

  if (!seatsAvailable(wave, entry.friendIgn)) {
    return false;
  }

  wave.waitlist.splice(index, 1);
  wave.attendees[userId] = entry;

  return true;
}

function promoteFirstFit(wave) {
  let changed = true;

  while (changed) {
    changed = false;

    const index = wave.waitlist.findIndex(
      attendee => seatsAvailable(wave, attendee.friendIgn)
    );

    if (index >= 0) {
      const entry = wave.waitlist.splice(index, 1)[0];
      wave.attendees[entry.userId] = entry;
      changed = true;
    }
  }
}

function getEventWaveOrReply(interaction, eventId, waveId) {
  const event = getEvent(eventId);
  const wave = getWave(eventId, waveId);

  if (!event || !wave) {
    interaction.reply({
      content: "Event or wave not found. Check the IDs using /ppg-events.",
      flags: MessageFlags.Ephemeral
    });

    return null;
  }

  return { event, wave };
}

client.once("ready", () => {
  console.log(`PPG Signup Bot online as ${client.user.tag}`);
});
client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      if (!isAdmin(interaction)) {
        return interaction.reply({
          content: "You need Administrator permission to use this command.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (cmd === "ppg-create") {
        const host = interaction.options.getUser("host");
        const c1 = interaction.options.getUser("cohost1");
        const c2 = interaction.options.getUser("cohost2");

        if (!validHostTeam(host, c1, c2)) {
          return interaction.reply({
            content: "The host and both co-hosts must be three different people.",
            flags: MessageFlags.Ephemeral
          });
        }

        const eventId = makeId();
        const wave = createWave("Wave 1", interaction.channelId);

        db.events[eventId] = {
          id: eventId,
          name: short(interaction.options.getString("name")),
          type: interaction.options.getString("type"),
          dateText: short(interaction.options.getString("date") || "", 80),
          hostId: host.id,
          cohost1Id: c1.id,
          cohost2Id: c2.id,
          createdBy: interaction.user.id,
          createdAt: new Date().toISOString(),
          ended: false,
          waves: { [wave.id]: wave }
        };

        saveData();

        await interaction.reply({
          content: `Creating event **${db.events[eventId].name}**…`,
          flags: MessageFlags.Ephemeral
        });

        await postPanel(interaction, eventId, wave.id);

        return interaction.followUp({
          content:
            `Event created.\nEvent ID: \`${eventId}\`\n` +
            `Wave 1 ID: \`${wave.id}\`\nSave these IDs for management commands.`,
          flags: MessageFlags.Ephemeral
        });
      }

      if (cmd === "ppg-events") {
        const list = Object.values(db.events);

        if (!list.length) {
          return interaction.reply({
            content: "No events have been created yet.",
            flags: MessageFlags.Ephemeral
          });
        }

        const lines = list.slice(-25).map(event =>
          `**${event.name}** (${event.type}) — ID \`${event.id}\` — ` +
          `${Object.values(event.waves || {}).length} wave(s)` +
          (event.ended ? " — ENDED" : "")
        );

        return interaction.reply({
          content: lines.join("\n").slice(0, 1900),
          flags: MessageFlags.Ephemeral
        });
      }

      if (cmd === "ppg-stats") {
        const all = Object.values(db.events);
        const waves = all.flatMap(event =>
          Object.values(event.waves || {})
        );

        const confirmed = waves.reduce(
          (sum, wave) => sum + totalSeats(wave),
          0
        );

        const waiting = waves.reduce(
          (sum, wave) => sum + totalWaitingSeats(wave),
          0
        );

        return interaction.reply({
          content:
            `**PPG Bot Statistics**\n` +
            `Events: ${all.length}\n` +
            `Waves: ${waves.length}\n` +
            `Confirmed attendee places: ${confirmed}\n` +
            `Waiting-list attendee places: ${waiting}`,
          flags: MessageFlags.Ephemeral
        });
      }

      const eventId = interaction.options.getString("event_id");
      const event = eventId ? getEvent(eventId) : null;

      if (
        ["ppg-wave", "ppg-edit", "ppg-end", "ppg-delete"].includes(cmd) &&
        !event
      ) {
        return interaction.reply({
          content: "Event not found. Use /ppg-events to see event IDs.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (cmd === "ppg-wave") {
        const wave = createWave(
          short(interaction.options.getString("name"), 40),
          interaction.channelId
        );

        event.waves[wave.id] = wave;
        saveData();

        await interaction.reply({
          content: `Creating **${wave.name}**…`,
          flags: MessageFlags.Ephemeral
        });

        await postPanel(interaction, eventId, wave.id);

        return interaction.followUp({
          content:
            `Wave created.\nEvent ID: \`${eventId}\`\n` +
            `Wave ID: \`${wave.id}\``,
          flags: MessageFlags.Ephemeral
        });
      }

      if (cmd === "ppg-edit") {
        const name = interaction.options.getString("name");
        const date = interaction.options.getString("date");
        const host = interaction.options.getUser("host");
        const c1 = interaction.options.getUser("cohost1");
        const c2 = interaction.options.getUser("cohost2");

        const newHost = host || { id: event.hostId };
        const newC1 = c1 || { id: event.cohost1Id };
        const newC2 = c2 || { id: event.cohost2Id };

        if (
          new Set([newHost.id, newC1.id, newC2.id]).size !== 3
        ) {
          return interaction.reply({
            content: "Host and co-hosts must be three different people.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (name) event.name = short(name);

        if (date !== null) {
          event.dateText = date === "-" ? "" : short(date, 80);
        }

        event.hostId = newHost.id;
        event.cohost1Id = newC1.id;
        event.cohost2Id = newC2.id;

        saveData();

        for (const waveId of Object.keys(event.waves)) {
          await refreshPanel(eventId, waveId);
        }

        return interaction.reply({
          content: `Updated **${event.name}**.`,
          flags: MessageFlags.Ephemeral
        });
      }

      if (cmd === "ppg-end") {
        event.ended = true;

        for (const wave of Object.values(event.waves)) {
          wave.open = false;
        }

        saveData();

        for (const waveId of Object.keys(event.waves)) {
          await refreshPanel(eventId, waveId);
        }

        return interaction.reply({
          content: `Ended **${event.name}**. Records were preserved.`,
          flags: MessageFlags.Ephemeral
        });
      }

      if (cmd === "ppg-delete") {
        if (interaction.options.getString("confirm") !== "DELETE") {
          return interaction.reply({
            content: "Deletion cancelled.",
            flags: MessageFlags.Ephemeral
          });
        }

        for (const wave of Object.values(event.waves)) {
          try {
            const channel = await client.channels.fetch(wave.channelId);
            const message = await channel.messages.fetch(wave.messageId);
            await message.delete();
          } catch {}
        }

        delete db.events[eventId];
        saveData();

        return interaction.reply({
          content: `Deleted event \`${eventId}\` and its stored data.`,
          flags: MessageFlags.Ephemeral
        });
      }

      const waveId = interaction.options.getString("wave_id");
      const found = getEventWaveOrReply(interaction, eventId, waveId);

      if (!found) return;

      const { wave } = found;

      if (cmd === "ppg-open" || cmd === "ppg-close") {
        wave.open = cmd === "ppg-open";

        saveData();
        await refreshPanel(eventId, waveId);

        return interaction.reply({
          content: `Signups are now ${wave.open ? "open" : "closed"}.`,
          flags: MessageFlags.Ephemeral
        });
      }

      if (cmd === "ppg-add") {
        const member = interaction.options.getUser("member");

        if (
          wave.attendees[member.id] ||
          wave.waitlist.some(a => a.userId === member.id)
        ) {
          return interaction.reply({
            content: "That member is already registered for this wave.",
            flags: MessageFlags.Ephemeral
          });
        }

        const entry = entryFor(
          member.id,
          interaction.options.getString("ign"),
          interaction.options.getString("friend_ign") || "",
          interaction.user.id
        );

        const result = enqueueOrConfirm(wave, entry);

        if (result === "full") {
          return interaction.reply({
            content: "The attendee list and waiting list are full.",
            flags: MessageFlags.Ephemeral
          });
        }

        saveData();
        await refreshPanel(eventId, waveId);

        return interaction.reply({
          content: result === "confirmed"
            ? `Added ${member} to confirmed attendees.`
            : `Added ${member} to the waiting list.`,
          flags: MessageFlags.Ephemeral
        });
      }

      if (cmd === "ppg-remove") {
        const member = interaction.options.getUser("member");

        if (wave.attendees[member.id]) {
          delete wave.attendees[member.id];
          promoteFirstFit(wave);
        } else {
          const index = wave.waitlist.findIndex(
            a => a.userId === member.id
          );

          if (index < 0) {
            return interaction.reply({
              content: "That member is not on this wave's list.",
              flags: MessageFlags.Ephemeral
            });
          }

          wave.waitlist.splice(index, 1);
        }

        saveData();
        await refreshPanel(eventId, waveId);

        return interaction.reply({
          content: `Removed ${member} from this wave.`,
          flags: MessageFlags.Ephemeral
        });
      }

      if (cmd === "ppg-promote") {
        const member = interaction.options.getUser("member");

        if (!promoteWaiting(wave, member.id)) {
          return interaction.reply({
            content: "That member is not on the waiting list or there isn't room for their whole signup.",
            flags: MessageFlags.Ephemeral
          });
        }

        saveData();
        await refreshPanel(eventId, waveId);

        return interaction.reply({
          content: `Promoted ${member} to confirmed attendees.`,
          flags: MessageFlags.Ephemeral
        });
      }

      if (cmd === "ppg-list" || cmd === "ppg-waitlist") {
        const entries = cmd === "ppg-waitlist"
          ? wave.waitlist
          : Object.values(wave.attendees);

        if (!entries.length) {
          return interaction.reply({
            content: "No signups in this list.",
            flags: MessageFlags.Ephemeral
          });
        }

        const lines = entries.map((a, i) =>
          `${i + 1}. <@${a.userId}> — ${a.ign}` +
          (a.friendIgn ? ` (+1: ${a.friendIgn})` : "")
        );

        return interaction.reply({
          content: lines.join("\n").slice(0, 1900),
          flags: MessageFlags.Ephemeral
        });
      }

      if (cmd === "ppg-attendance") {
        return interaction.reply({
          content:
            `**${event.name} — ${wave.name}**\n` +
            `Confirmed places: ${totalSeats(wave)}/22\n` +
            `Waiting-list places: ${totalWaitingSeats(wave)}\n` +
            `Status: ${wave.open ? "Open" : "Closed"}`,
          flags: MessageFlags.Ephemeral
        });
      }

      if (cmd === "ppg-export") {
        const rows = [
          ["Discord User ID", "IGN", "Friend IGN", "Status", "Signed Up At"]
        ];

        for (const a of Object.values(wave.attendees)) {
          rows.push([
            a.userId, a.ign, a.friendIgn, "Confirmed", a.signedUpAt
          ]);
        }

        for (const a of wave.waitlist) {
          rows.push([
            a.userId, a.ign, a.friendIgn, "Waiting list", a.signedUpAt
          ]);
        }

        const csv = rows
          .map(row => row.map(csvCell).join(","))
          .join("\n");

        const file = new AttachmentBuilder(
          Buffer.from(csv, "utf8"),
          { name: `ppg-${eventId}-${waveId}.csv` }
        );

        return interaction.reply({
          content: "Attendance export:",
          files: [file],
          flags: MessageFlags.Ephemeral
        });
      }

      if (cmd === "ppg-panel") {
        await postPanel(interaction, eventId, waveId);

        return interaction.reply({
          content: "Posted a fresh signup panel in this channel.",
          flags: MessageFlags.Ephemeral
        });
      }
    }
    if (interaction.isButton()) {
      const parts = interaction.customId.split(":");

      if (parts[0] !== "ppg") return;

      const [, action, eventId, waveId] = parts;
      const event = getEvent(eventId);
      const wave = getWave(eventId, waveId);

      if (!event || !wave) {
        return interaction.reply({
          content: "This event is no longer available.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (action === "cancel") {
        if (wave.attendees[interaction.user.id]) {
          delete wave.attendees[interaction.user.id];
          promoteFirstFit(wave);

          saveData();
          await refreshPanel(eventId, waveId);

          return interaction.reply({
            content: "Your signup has been cancelled. The next eligible waiting-list signup has been promoted if there was room.",
            flags: MessageFlags.Ephemeral
          });
        }

        const index = wave.waitlist.findIndex(
          a => a.userId === interaction.user.id
        );

        if (index >= 0) {
          wave.waitlist.splice(index, 1);

          saveData();
          await refreshPanel(eventId, waveId);

          return interaction.reply({
            content: "Your waiting-list signup has been cancelled.",
            flags: MessageFlags.Ephemeral
          });
        }

        return interaction.reply({
          content: "You do not have a signup for this wave.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (action === "signup") {
        if (!wave.open || event.ended) {
          return interaction.reply({
            content: "Signups are closed.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (hostIds(event).includes(interaction.user.id)) {
          return interaction.reply({
            content: "You're part of the host team and don't need an attendee place.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (
          wave.attendees[interaction.user.id] ||
          wave.waitlist.some(a => a.userId === interaction.user.id)
        ) {
          return interaction.reply({
            content: "You're already registered for this wave.",
            flags: MessageFlags.Ephemeral
          });
        }

        const modal = new ModalBuilder()
          .setCustomId(`ppgform:${eventId}:${waveId}`)
          .setTitle("PPG Party Signup");

        const ign = new TextInputBuilder()
          .setCustomId("ign")
          .setLabel("Your in-game name (IGN)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(50);

        const friendChoice = new TextInputBuilder()
          .setCustomId("friend")
          .setLabel("Add a friend? Enter YES or NO")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(3)
          .setPlaceholder("NO");

        const friendIgn = new TextInputBuilder()
          .setCustomId("friendign")
          .setLabel("Friend's IGN (if YES)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(50);

        modal.addComponents(
          new ActionRowBuilder().addComponents(ign),
          new ActionRowBuilder().addComponents(friendChoice),
          new ActionRowBuilder().addComponents(friendIgn)
        );

        return interaction.showModal(modal);
      }
    }

    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith("ppgform:")
    ) {
      const [, eventId, waveId] = interaction.customId.split(":");
      const event = getEvent(eventId);
      const wave = getWave(eventId, waveId);

      if (!event || !wave || !wave.open || event.ended) {
        return interaction.reply({
          content: "Signups are closed.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (hostIds(event).includes(interaction.user.id)) {
        return interaction.reply({
          content: "Host team members do not use attendee places.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (
        wave.attendees[interaction.user.id] ||
        wave.waitlist.some(a => a.userId === interaction.user.id)
      ) {
        return interaction.reply({
          content: "You're already registered for this wave.",
          flags: MessageFlags.Ephemeral
        });
      }

      const ign = short(
        interaction.fields.getTextInputValue("ign"),
        50
      );

      const friendChoice = short(
        interaction.fields.getTextInputValue("friend"),
        3
      ).toLowerCase();

      const friendIgn = short(
        interaction.fields.getTextInputValue("friendign") || "",
        50
      );

      const wantsFriend = ["yes", "y"].includes(friendChoice);

      if (!["yes", "y", "no", "n"].includes(friendChoice)) {
        return interaction.reply({
          content: "For 'Add a friend?', enter YES or NO.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (wantsFriend && !friendIgn) {
        return interaction.reply({
          content: "You chose to add a friend. Please enter their IGN and sign up again.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (!wantsFriend && friendIgn) {
        return interaction.reply({
          content: "You entered a friend's name but selected NO. Please sign up again and choose YES.",
          flags: MessageFlags.Ephemeral
        });
      }

      const result = enqueueOrConfirm(
        wave,
        entryFor(
          interaction.user.id,
          ign,
          wantsFriend ? friendIgn : "",
          interaction.user.id
        )
      );

      if (result === "full") {
        return interaction.reply({
          content: "The attendee list and waiting list are full. Please contact an admin.",
          flags: MessageFlags.Ephemeral
        });
      }

      saveData();
      await refreshPanel(eventId, waveId);

      return interaction.reply({
        content: result === "confirmed"
          ? `You're confirmed for **${event.name} — ${wave.name}**` +
            (wantsFriend ? ` with +1: **${friendIgn}**.` : ".")
          : `The wave is full, so you've been added to the waiting list` +
            (wantsFriend ? ` with +1: **${friendIgn}**.` : "."),
        flags: MessageFlags.Ephemeral
      });
    }
  } catch (error) {
    console.error("Interaction failed:", error);

    if (
      interaction.isRepliable() &&
      !interaction.replied &&
      !interaction.deferred
    ) {
      await interaction.reply({
        content: "Something went wrong. Please try again or contact an administrator.",
        flags: MessageFlags.Ephemeral
      }).catch(() => {});
    }
  }
});

async function start() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log("PPG slash commands registered.");

  await client.login(TOKEN);
}

start().catch(error => {
  console.error("Bot startup failed:", error);
  process.exit(1);
});
