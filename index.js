
require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  MessageFlags,
  AttachmentBuilder
} = require("discord.js");

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// ==================================================
// CONFIGURATION
// ==================================================

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const ADMIN_ROLE_ID = "1496238349722325103";

const DATA_DIR = process.env.DATA_DIR || "/data";
const DATA_FILE = path.join(DATA_DIR, "ppg-data.json");

const CAPACITY = 22;
const WAITLIST_CAPACITY = 5;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  throw new Error(
    "Missing DISCORD_TOKEN, CLIENT_ID or GUILD_ID."
  );
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const eventTypes = [
  { name: "200 Sponty", value: "200 Sponty" },
  { name: "400 Gems", value: "400 Gems" },
  { name: "600 Gems", value: "600 Gems" },
  { name: "1K Gems", value: "1K Gems" }
];

const commands = [
  new SlashCommandBuilder()
    .setName("ppg")
    .setDescription("Open the PPG event management panel.")
    .setDefaultMemberPermissions(null)
    .toJSON()
];

// ==================================================
// DATA STORAGE
// ==================================================

function makeId() {
  return crypto.randomBytes(4).toString("hex");
}

function short(value, max = 80) {
  return String(value ?? "").trim().slice(0, max);
}

function readData() {
  try {
    const data = JSON.parse(
      fs.readFileSync(DATA_FILE, "utf8")
    );

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { events: {} };
    }

    return data;
  } catch (error) {
    if (error.code === "ENOENT") {
      return { events: {} };
    }

    throw error;
  }
}

let db = readData();

if (
  !db.events ||
  typeof db.events !== "object" ||
  Array.isArray(db.events)
) {
  db.events = {};
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

function normaliseEntry(entry) {
  entry = entry && typeof entry === "object" ? entry : {};

  entry.userId =
    entry.userId && String(entry.userId) !== "null"
      ? String(entry.userId)
      : null;

  entry.ign = short(entry.ign, 50);
  entry.gameTag = short(entry.gameTag || entry.tag || "", 50);
  entry.tag = entry.gameTag;
  entry.friendIgn = short(entry.friendIgn || "", 50);
  entry.friendTag = short(entry.friendTag || "", 50);

  return entry;
}

function normaliseWave(wave) {
  wave.attendees = Array.isArray(wave.attendees)
    ? Object.fromEntries(
        wave.attendees.map((entry, index) => {
          const item = normaliseEntry(entry);
          const key = item.userId || `guest_migrated_${index}_${makeId()}`;
          return [key, item];
        })
      )
    : wave.attendees &&
        typeof wave.attendees === "object"
      ? Object.fromEntries(
          Object.entries(wave.attendees).map(([key, entry]) => [
            key,
            normaliseEntry(entry)
          ])
        )
      : {};

  wave.waitlist = Array.isArray(wave.waitlist)
    ? wave.waitlist.map(normaliseEntry)
    : wave.waitlist &&
        typeof wave.waitlist === "object"
      ? Object.values(wave.waitlist).map(normaliseEntry)
      : [];

  wave.open ??= false;
  wave.pingMessages ??= [];

  return wave;
}

// Migrate old attendee arrays into the object format used by the bot.
for (const [eventId, event] of Object.entries(db.events)) {
  event.id ||= eventId;
  event.waves ||= {};

  if (
    !event.waves ||
    typeof event.waves !== "object" ||
    Array.isArray(event.waves)
  ) {
    event.waves = {};
  }

  for (const [waveId, wave] of Object.entries(event.waves)) {
    wave.id ||= waveId;
    wave.name ||= "Wave";
    wave.attendees ??= {};
    wave.waitlist ??= [];
    normaliseWave(wave);
  }
}

saveData();

// ==================================================
// EVENT HELPERS
// ==================================================

function isPPGAdmin(interaction) {
  return interaction.member?.roles?.cache?.has(ADMIN_ROLE_ID) ?? false;
}

function getEvent(eventId) {
  return db.events[eventId];
}

function getWave(eventId, waveId) {
  return getEvent(eventId)?.waves?.[waveId];
}

function totalSeats(wave) {
  return Object.values(wave.attendees || {}).reduce(
    (sum, entry) => sum + 1 + (entry.friendIgn ? 1 : 0),
    0
  );
}

function totalWaitingSeats(wave) {
  return (wave.waitlist || []).reduce(
    (sum, entry) => sum + 1 + (entry.friendIgn ? 1 : 0),
    0
  );
}

function seatsAvailable(wave, entry) {
  const size = 1 + (entry.friendIgn ? 1 : 0);
  return totalSeats(wave) + size <= CAPACITY;
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
    pingMessages: [],
    createdAt: new Date().toISOString()
  };
}

function enqueueOrConfirm(wave, entry) {
  wave.attendees ||= {};
  wave.waitlist ||= [];

  const size = 1 + (entry.friendIgn ? 1 : 0);

  if (
    totalSeats(wave) + size <= CAPACITY &&
    wave.waitlist.length === 0
  ) {
    const key = entry.userId || `guest_${makeId()}`;

    wave.attendees[key] = {
      ...entry,
      gameTag: entry.gameTag || entry.tag || "",
      tag: entry.gameTag || entry.tag || ""
    };

    return { ok: true, status: "confirmed" };
  }

  if (wave.waitlist.length < WAITLIST_CAPACITY) {
    wave.waitlist.push({
      ...entry,
      gameTag: entry.gameTag || entry.tag || "",
      tag: entry.gameTag || entry.tag || ""
    });

    return { ok: true, status: "waitlist" };
  }

  return {
    ok: false,
    status: "full",
    message: "There are no available places or waiting-list slots."
  };
}

function promoteFirstFit(wave) {
  wave.waitlist ||= [];
  wave.attendees ||= {};

  let changed = true;

  while (changed) {
    changed = false;

    const index = wave.waitlist.findIndex(entry =>
      seatsAvailable(wave, entry)
    );

    if (index >= 0) {
      const entry = wave.waitlist.splice(index, 1)[0];
      const key = entry.userId || `guest_${makeId()}`;

      wave.attendees[key] = entry;
      changed = true;
    }
  }
}

function promoteWaitingEntry(wave, index) {
  const entry = wave.waitlist[index];

  if (!entry || !seatsAvailable(wave, entry)) {
    return false;
  }

  wave.waitlist.splice(index, 1);

  const key = entry.userId || `guest_${makeId()}`;
  wave.attendees[key] = entry;

  return true;
}

function formatEntry(entry, index) {
  let text =
    `**${index + 1}.** ` +
    (entry.userId
      ? `<@${entry.userId}>`
      : `**${entry.ign || "Guest"}**`) +
    (entry.gameTag || entry.tag
      ? ` | Tag: ${entry.gameTag || entry.tag}`
      : "");

  if (entry.friendIgn) {
    text += `\n   ↳ Friend: **${entry.friendIgn}**`;

    if (entry.friendTag) {
      text += ` | Tag: ${entry.friendTag}`;
    }
  }

  return text;
}

// ==================================================
// PUBLIC SIGNUP PANEL
// ==================================================

function panelPayload(eventId, waveId) {
  const event = getEvent(eventId);
  const wave = getWave(eventId, waveId);

  const embed = new EmbedBuilder()
    .setColor(
      wave.open && !event.ended ? 0x238636 : 0x8b2635
    )
    .setTitle(`🎉 ${event.name}`)
    .setDescription(
      `**Type:** ${event.type}\n` +
      (event.dateText ? `**When:** ${event.dateText}\n` : "") +
      `**Host:** ${event.hostName || "Not specified"}\n` +
      `**Co-hosts:** ${event.cohost1Name || "Not specified"} and ${event.cohost2Name || "Not specified"}\n\n` +
      `**Attendee places:** ${totalSeats(wave)}/${CAPACITY}\n` +
      `**Waiting list:** ${totalWaitingSeats(wave)}/${CAPACITY}\n` +
      `**Waiting-list signups:** ${wave.waitlist.length}/${WAITLIST_CAPACITY}\n` +
      `**Signups:** ${wave.open && !event.ended ? "🟢 OPEN" : "🔴 CLOSED"}\n\n` +
      "**To sign up:** Press Sign Up and enter your IGN, Tag, " +
      "whether you are adding a friend, and your friend's IGN and Tag if applicable."
    )
    .setFooter({ text: "PPG Signup System 💜" });

  const attendees = Object.values(wave.attendees || {});

  if (attendees.length) {
    const lines = [];
    let length = 0;

    for (const [index, entry] of attendees.entries()) {
      const line = formatEntry(entry, index);

      if (length + line.length + 1 > 1000) {
        lines.push("…");
        break;
      }

      lines.push(line);
      length += line.length + 1;
    }

    embed.addFields({
      name: "📋 Confirmed attendees",
      value: lines.join("\n")
    });
  }

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`ppg:signup:${eventId}:${waveId}`)
          .setLabel("Sign Up")
          .setEmoji("📝")
          .setStyle(ButtonStyle.Success)
          .setDisabled(!wave.open || event.ended),
        new ButtonBuilder()
          .setCustomId(`ppg:cancel:${eventId}:${waveId}`)
          .setLabel("Cancel Signup")
          .setEmoji("❌")
          .setStyle(ButtonStyle.Danger)
          .setDisabled(!wave.open || event.ended)
      )
    ]
  };
}

async function refreshPanel(eventId, waveId) {
  const wave = getWave(eventId, waveId);

  if (!wave?.channelId || !wave?.messageId) return;

  try {
    const channel = await client.channels.fetch(wave.channelId);

    if (!channel?.messages) return;

    const message = await channel.messages.fetch(wave.messageId);
    await message.edit(panelPayload(eventId, waveId));
  } catch (error) {
    console.error("Panel refresh failed:", error.message);
  }
}

async function postPanel(channel, eventId, waveId) {
  if (!channel?.send) {
    throw new Error("Use this action in a text channel.");
  }

  const message = await channel.send(panelPayload(eventId, waveId));
  const wave = getWave(eventId, waveId);

  wave.channelId = message.channelId;
  wave.messageId = message.id;

  saveData();
}

// ==================================================
// ADMIN MENUS
// ==================================================

function mainMenu() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("ppg:create-event")
        .setLabel("Create Event")
        .setEmoji("➕")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("ppg:create-wave")
        .setLabel("Create Wave")
        .setEmoji("🌊")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("ppg:manage")
        .setLabel("Manage Events")
        .setEmoji("⚙️")
        .setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("ppg:delete-events")
        .setLabel("Delete Events")
        .setEmoji("🗑️")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("ppg:stats")
        .setLabel("Statistics")
        .setEmoji("📊")
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

function eventMenu(customId = "ppg:select-event") {
  const events = Object.values(db.events).slice(-25);
  if (!events.length) return null;

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder("Select an event")
      .addOptions(
        events.map(event => ({
          label: short(event.name, 100),
          description: `${event.type}${event.ended ? " • Ended" : ""}`.slice(0, 100),
          value: event.id
        }))
      )
  );
}

function waveMenu(eventId) {
  const event = getEvent(eventId);
  if (!event) return null;

  const waves = Object.values(event.waves || {}).slice(0, 25);
  if (!waves.length) return null;

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ppg:select-wave:${eventId}`)
      .setPlaceholder("Select a wave")
      .addOptions(
        waves.map(wave => ({
          label: short(wave.name, 100),
          description:
            `${totalSeats(wave)}/${CAPACITY} places • ${wave.open ? "Open" : "Closed"}`,
          value: wave.id
        }))
      )
  );
}

function waveActionsMenu(eventId, waveId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ppg:wave-action:${eventId}:${waveId}`)
      .setPlaceholder("Choose an action")
      .addOptions(
        { label: "Attendance summary", value: "attendance" },
        { label: "Confirmed attendee list", value: "list" },
        { label: "Waiting list", value: "waitlist" },
        { label: "Add attendee", value: "add", emoji: "➕" },
        { label: "Open signups", value: "open" },
        { label: "Close signups", value: "close" },
        { label: "Repost signup panel", value: "panel" },
        { label: "Cancel entire event", value: "cancel-event" },
        { label: "Export CSV", value: "export" },
        { label: "Remove attendee", value: "remove" },
        { label: "Ping all confirmed attendees", value: "ping", emoji: "📣" },
        { label: "Promote from waiting list", value: "promote" }
      )
  );
}

function confirmationMenu(customId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder("Confirm your choice")
      .addOptions(
        { label: "YES — confirm", value: "yes", emoji: "✅" },
        { label: "NO — go back", value: "no", emoji: "↩️" }
      )
  );
}

function memberMenu(eventId, waveId, action) {
  const wave = getWave(eventId, waveId);
  if (!wave) return null;

  const entries = action === "promote"
    ? wave.waitlist
    : Object.entries(wave.attendees || {}).map(([key, entry]) => ({
        ...entry,
        _storageKey: key
      }));

  if (!entries.length) return null;

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ppg:member:${action}:${eventId}:${waveId}`)
      .setPlaceholder("Select a member")
      .addOptions(
        entries.slice(0, 25).map((entry, index) => ({
          label: short(entry.ign || entry.userId || "Guest", 100),
          description: action === "promote" ? "Waiting list" : "Confirmed attendee",
          value: String(index)
        }))
      )
  );
}

// ==================================================
// MODALS
// ==================================================

function createEventModal() {
  const modal = new ModalBuilder()
    .setCustomId("ppgform:create-event")
    .setTitle("Create PPG Event");

  const fields = [
    ["name", "Event name", 80, "e.g. Friday Royale"],
    ["type", "Event type", 20, "200 Sponty, 400 Gems, 600 Gems or 1K Gems"],
    ["host", "Host name", 50, "Enter the host's name"],
    ["cohost1", "Co-host 1 name", 50, "Enter the first co-host's name"],
    ["cohost2", "Co-host 2 name", 50, "Enter the second co-host's name"]
  ];

  for (const [id, label, max, placeholder] of fields) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(id)
          .setLabel(label)
          .setStyle(TextInputStyle.Short)
          .setMaxLength(max)
          .setRequired(id !== "cohost1" && id !== "cohost2")
          .setPlaceholder(placeholder)
      )
    );
  }

  return modal;
}

function createWaveModal(eventId) {
  const modal = new ModalBuilder()
    .setCustomId(`ppgform:create-wave:${eventId}`)
    .setTitle("Create Event Wave");

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("name")
        .setLabel("Wave name")
        .setStyle(TextInputStyle.Short)
        .setMaxLength(40)
        .setRequired(true)
        .setPlaceholder("Wave 2")
    )
  );

  return modal;
}

function entryModal(eventId, waveId) {
  const modal = new ModalBuilder()
    .setCustomId(`ppgform:add:${eventId}:${waveId}`)
    .setTitle("Manually Add Attendee");

  const fields = [
    ["ign", "Guest/member IGN", true, 50],
    ["tag", "In-game Tag", true, 50],
    ["friendign", "Friend IGN (optional)", false, 50],
    ["friendtag", "Friend Tag (optional)", false, 50],
    ["memberid", "Discord ID (optional)", false, 30]
  ];

  for (const [id, label, required, max] of fields) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(id)
          .setLabel(label)
          .setStyle(TextInputStyle.Short)
          .setRequired(required)
          .setMaxLength(max)
      )
    );
  }

  return modal;
}

// ==================================================
// DELETE EVENTS
// ==================================================

async function deleteEvents(eventIds) {
  const deleted = [];
  const failed = [];

  for (const eventId of eventIds) {
    const event = getEvent(eventId);
    if (!event) continue;

    let allMessagesDeleted = true;

    for (const wave of Object.values(event.waves || {})) {
      const messages = [];

      if (wave.channelId && wave.messageId) {
        messages.push({
          channelId: wave.channelId,
          messageId: wave.messageId
        });
      }

      messages.push(...(wave.pingMessages || []));

      for (const item of messages) {
        try {
          const channel = await client.channels.fetch(item.channelId);
          if (!channel?.messages) {
            allMessagesDeleted = false;
            continue;
          }

          const message = await channel.messages.fetch(item.messageId);
          await message.delete();
        } catch (error) {
          if (error.code !== 10008) {
            allMessagesDeleted = false;
            console.error("Message deletion failed:", error.message);
          }
        }
      }
    }

    if (!allMessagesDeleted) {
      failed.push(event.name);
      continue;
    }

    delete db.events[eventId];
    deleted.push(event.name);
  }

  saveData();
  return { deleted, failed };
}

// ==================================================
// BOT READY
// ==================================================

client.once("ready", () => {
  console.log(`PPG Bot online as ${client.user.tag}`);
});

// ==================================================
// INTERACTIONS
// ==================================================

client.on("interactionCreate", async interaction => {
  try {
    // Slash command
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== "ppg") return;

      if (!isPPGAdmin(interaction)) {
        return interaction.reply({
          content: "⛔ Only members with the PPG Admin role can use this command.",
          flags: MessageFlags.Ephemeral
        });
      }

      return interaction.reply({
        content: "**🏛️ PPG Management Panel**\nChoose an action below.",
        components: mainMenu(),
        flags: MessageFlags.Ephemeral
      });
    }

    // Buttons
    if (interaction.isButton()) {
      if (!interaction.customId.startsWith("ppg:")) return;

      const parts = interaction.customId.split(":");
      const action = parts[1];

      if (
        ["create-event", "create-wave", "manage", "delete-events", "stats"]
          .includes(action)
      ) {
        if (!isPPGAdmin(interaction)) {
          return interaction.reply({
            content: "⛔ Administrator permission is required.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (action === "create-event") {
          return interaction.showModal(createEventModal());
        }

        if (action === "create-wave") {
          const row = eventMenu("ppg:create-wave-select");

          return interaction.reply({
            content: row ? "Select the event for the new wave." : "Create an event first.",
            components: row ? [row] : [],
            flags: MessageFlags.Ephemeral
          });
        }

        if (action === "manage") {
          const row = eventMenu("ppg:manage-select");

          return interaction.reply({
            content: row ? "Select an event to manage." : "There are no events yet.",
            components: row ? [row] : [],
            flags: MessageFlags.Ephemeral
          });
        }

        if (action === "delete-events") {
          const events = Object.values(db.events).slice(-24);

          if (!events.length) {
            return interaction.reply({
              content: "There are no events to delete.",
              flags: MessageFlags.Ephemeral
            });
          }

          const options = events.map(event => ({
            label: short(event.name, 100),
            description: `${event.type}${event.ended ? " • Ended" : ""}`.slice(0, 100),
            value: event.id
          }));

          options.push({
            label: "ALL EVENTS",
            description: "Delete all events and signup records",
            value: "ALL"
          });

          return interaction.reply({
            content: "Select event(s) to delete. You must confirm before deletion.",
            components: [
              new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                  .setCustomId("ppg:delete-select")
                  .setPlaceholder("Select events to delete")
                  .setMinValues(1)
                  .setMaxValues(options.length)
                  .addOptions(options)
              )
            ],
            flags: MessageFlags.Ephemeral
          });
        }

        if (action === "stats") {
          const events = Object.values(db.events);
          const waves = events.flatMap(event => Object.values(event.waves || {}));

          return interaction.reply({
            content:
              `**📊 PPG Statistics**\n` +
              `Events: **${events.length}**\n` +
              `Waves: **${waves.length}**\n` +
              `Confirmed places: **${waves.reduce((n, wave) => n + totalSeats(wave), 0)}**\n` +
              `Waiting-list places: **${waves.reduce((n, wave) => n + totalWaitingSeats(wave), 0)}**`,
            flags: MessageFlags.Ephemeral
          });
        }
      }

      const [, signupAction, eventId, waveId] = parts;
      if (!["signup", "cancel"].includes(signupAction)) return;

      const event = getEvent(eventId);
      const wave = getWave(eventId, waveId);

      if (!event || !wave) {
        return interaction.reply({
          content: "This event is no longer available.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (signupAction === "cancel") {
        if (wave.attendees[interaction.user.id]) {
          delete wave.attendees[interaction.user.id];
          promoteFirstFit(wave);
          saveData();
          await refreshPanel(eventId, waveId);

          return interaction.reply({
            content: "Your confirmed signup has been cancelled.",
            flags: MessageFlags.Ephemeral
          });
        }

        const index = wave.waitlist.findIndex(
          entry => entry.userId === interaction.user.id
        );

        if (index >= 0) {
          wave.waitlist.splice(index, 1);
          promoteFirstFit(wave);
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

      if (!wave.open || event.ended) {
        return interaction.reply({
          content: "Signups are closed.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (
        wave.attendees[interaction.user.id] ||
        wave.waitlist.some(entry => entry.userId === interaction.user.id)
      ) {
        return interaction.reply({
          content: "You're already registered for this wave.",
          flags: MessageFlags.Ephemeral
        });
      }

      const modal = new ModalBuilder()
        .setCustomId(`ppgform:signup:${eventId}:${waveId}`)
        .setTitle("PPG Party Signup");

      const fields = [
        ["ign", "1. Your in-game name (IGN)", true, "Enter your IGN"],
        ["gametag", "2. Your in-game Tag", true, "Enter your tag"],
        ["friend", "3. Add a friend? YES or NO", true, "YES or NO"],
        ["friendign", "4. Friend's IGN (if YES)", false, "Leave blank if NO"],
        ["friendtag", "5. Friend's Tag (if YES)", false, "Leave blank if NO"]
      ];

      modal.addComponents(
        ...fields.map(([id, label, required, placeholder]) =>
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId(id)
              .setLabel(label)
              .setStyle(TextInputStyle.Short)
              .setRequired(required)
              .setMaxLength(id === "friend" ? 3 : 50)
              .setPlaceholder(placeholder)
          )
        )
      );

      return interaction.showModal(modal);
    }

    // Select menus
    if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;
      const selected = interaction.values[0];

      if (id.startsWith("ppg:") && !isPPGAdmin(interaction)) {
        return interaction.reply({
          content: "⛔ Administrator permission is required.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (id === "ppg:create-wave-select") {
        if (!getEvent(selected)) {
          return interaction.update({
            content: "Event not found.",
            components: []
          });
        }

        return interaction.showModal(createWaveModal(selected));
      }

      if (id === "ppg:manage-select") {
        const event = getEvent(selected);
        const row = waveMenu(selected);

        return interaction.update({
          content: event && row
            ? `**${event.name}** — select a wave.`
            : "Event or waves not found.",
          components: row ? [row] : []
        });
      }

      if (id.startsWith("ppg:select-wave:")) {
        const eventId = id.split(":")[2];
        const waveId = selected;
        const event = getEvent(eventId);
        const wave = getWave(eventId, waveId);

        if (!event || !wave) {
          return interaction.update({
            content: "Event or wave not found.",
            components: []
          });
        }

        return interaction.update({
          content:
            `**${event.name} — ${wave.name}**\n` +
            `${totalSeats(wave)}/${CAPACITY} places • ${wave.open ? "Open" : "Closed"}`,
          components: [waveActionsMenu(eventId, waveId)]
        });
      }

      if (id === "ppg:delete-select") {
        let ids = interaction.values;

        if (ids.includes("ALL")) {
          ids = Object.keys(db.events);
        }

        ids = [...new Set(ids)].filter(eventId => getEvent(eventId));

        if (!ids.length) {
          return interaction.update({
            content: "No events selected.",
            components: []
          });
        }

        const key = makeId();
        db.pendingDeletes ||= {};
        db.pendingDeletes[key] = {
          userId: interaction.user.id,
          eventIds: ids,
          createdAt: Date.now()
        };
        saveData();

        return interaction.update({
          content:
            `⚠️ **Confirm permanent deletion**\n\n` +
            ids.map(eventId => `• ${getEvent(eventId).name}`).join("\n").slice(0, 1100) +
            `\n\nThis deletes ${ids.length} event(s) and their signup records.`,
          components: [confirmationMenu(`ppg:delete-confirm:${key}`)]
        });
      }

      if (id.startsWith("ppg:delete-confirm:")) {
        const key = id.split(":")[2];
        const item = db.pendingDeletes?.[key];

        if (!item || item.userId !== interaction.user.id) {
          return interaction.update({
            content: "Confirmation expired. Open Delete Events again.",
            components: []
          });
        }

        delete db.pendingDeletes[key];

        if (selected !== "yes") {
          saveData();
          return interaction.update({
            content: "Deletion cancelled. No events were deleted.",
            components: []
          });
        }

        const result = await deleteEvents(
          item.eventIds.filter(eventId => getEvent(eventId))
        );

        let message =
          `🗑️ Deleted ${result.deleted.length} event(s) and their signup records.`;

        if (result.failed.length) {
          message += "\n\n⚠️ These events were kept because a message could not be deleted:\n" +
            result.failed.join("\n");
        }

        return interaction.update({
          content: message.slice(0, 1900),
          components: []
        });
      }

      if (id.startsWith("ppg:cancel-confirm:")) {
        const eventId = id.split(":")[2];
        const event = getEvent(eventId);

        if (!event) {
          return interaction.update({
            content: "Event not found.",
            components: []
          });
        }

        if (selected !== "yes") {
          const row = waveMenu(eventId);

          return interaction.update({
            content: `Cancellation cancelled for **${event.name}**.`,
            components: row ? [row] : []
          });
        }

        event.ended = true;

        for (const wave of Object.values(event.waves || {})) {
          wave.open = false;
        }

        saveData();

        for (const waveId of Object.keys(event.waves || {})) {
          await refreshPanel(eventId, waveId);
        }

        return interaction.update({
          content: `🔴 **${event.name} cancelled.** All waves are closed and records are preserved.`,
          components: []
        });
      }

      // Wave actions
      if (id.startsWith("ppg:wave-action:")) {
        const parts = id.split(":");
        const eventId = parts[2];
        const waveId = parts[3];
        const event = getEvent(eventId);
        const wave = getWave(eventId, waveId);

        if (!event || !wave) {
          return interaction.update({
            content: "Event or wave not found.",
            components: []
          });
        }

        if (selected === "add") {
          return interaction.showModal(entryModal(eventId, waveId));
        }

        if (selected === "cancel-event") {
          return interaction.update({
            content: `⚠️ Cancel **${event.name}** and close every wave? Attendee records will be kept.`,
            components: [confirmationMenu(`ppg:cancel-confirm:${eventId}`)]
          });
        }

        if (selected === "open" || selected === "close") {
          if (event.ended && selected === "open") {
            return interaction.update({
              content: "This event has ended. Create a new event to reopen signups.",
              components: [waveActionsMenu(eventId, waveId)]
            });
          }

          wave.open = selected === "open";
          saveData();
          await refreshPanel(eventId, waveId);

          return interaction.update({
            content: `Signups are now **${wave.open ? "OPEN" : "CLOSED"}**.`,
            components: [waveActionsMenu(eventId, waveId)]
          });
        }

        if (selected === "panel") {
          await postPanel(interaction.channel, eventId, waveId);

          return interaction.update({
            content: "New signup panel posted.",
            components: [waveActionsMenu(eventId, waveId)]
          });
        }

        if (selected === "ping") {
          const ids = Object.keys(wave.attendees || {})
            .filter(key => /^\d{17,20}$/.test(key));

          if (!ids.length) {
            return interaction.update({
              content: "There are no confirmed Discord members to ping.",
              components: [waveActionsMenu(eventId, waveId)]
            });
          }

          await interaction.update({
            content: `📣 Sending a ping to ${ids.length} confirmed attendee(s)…`,
            components: [waveActionsMenu(eventId, waveId)]
          });

          for (let i = 0; i < ids.length; i += 40) {
            const batch = ids.slice(i, i + 40);
            const msg = await interaction.channel.send({
              content: `📣 **PPG Event Reminder — ${event.name} | ${wave.name}**\n` +
                batch.map(userId => `<@${userId}>`).join(" "),
              allowedMentions: { users: batch, parse: [] }
            });

            wave.pingMessages ||= [];
            wave.pingMessages.push({
              channelId: msg.channelId,
              messageId: msg.id
            });
            saveData();
          }

          return;
        }

        if (selected === "attendance") {
          return interaction.update({
            content:
              `**${event.name} — ${wave.name}**\n` +
              `Confirmed places: ${totalSeats(wave)}/${CAPACITY}\n` +
              `Waiting-list places: ${totalWaitingSeats(wave)}\n` +
              `Waiting-list signups: ${wave.waitlist.length}/${WAITLIST_CAPACITY}\n` +
              `Signups: ${wave.open && !event.ended ? "Open" : "Closed"}`,
            components: [waveActionsMenu(eventId, waveId)]
          });
        }

        if (selected === "export") {
          const cell = value =>
            `"${String(value ?? "").replace(/"/g, '""')}"`;

          const rows = [[
            "Discord User ID", "IGN", "In-Game Tag",
            "Friend IGN", "Friend Tag", "Status", "Signed Up At"
          ]];

          for (const entry of Object.values(wave.attendees || {})) {
            rows.push([
              entry.userId, entry.ign, entry.gameTag || entry.tag,
              entry.friendIgn, entry.friendTag, "Confirmed", entry.signedUpAt
            ]);
          }

          for (const entry of wave.waitlist || []) {
            rows.push([
              entry.userId, entry.ign, entry.gameTag || entry.tag,
              entry.friendIgn, entry.friendTag, "Waiting list", entry.signedUpAt
            ]);
          }

          const csv = rows.map(row => row.map(cell).join(",")).join("\n");
          const file = new AttachmentBuilder(
            Buffer.from(csv, "utf8"),
            { name: `ppg-${eventId}-${waveId}.csv` }
          );

          return interaction.reply({
            content: `Export for ${event.name} — ${wave.name}`,
            files: [file],
            flags: MessageFlags.Ephemeral
          });
        }

        if (selected === "list" || selected === "waitlist") {
          const entries = selected === "waitlist"
            ? wave.waitlist
            : Object.values(wave.attendees || {});

          return interaction.update({
            content: entries.length
              ? entries.map(formatEntry).join("\n").slice(0, 1800)
              : selected === "waitlist"
                ? "Waiting list is empty."
                : "No confirmed attendees.",
            components: [waveActionsMenu(eventId, waveId)]
          });
        }

        if (selected === "remove" || selected === "promote") {
          const row = memberMenu(eventId, waveId, selected);

          if (!row) {
            return interaction.update({
              content: selected === "promote"
                ? "Waiting list is empty."
                : "No confirmed attendees.",
              components: [waveActionsMenu(eventId, waveId)]
            });
          }

          return interaction.update({
            content: selected === "promote"
              ? "Select the waiting-list entry to promote."
              : "Select the attendee to remove.",
            components: [row]
          });
        }
      }

      // Remove attendee or promote waiting-list entry
      if (id.startsWith("ppg:member:")) {
        const parts = id.split(":");
        const action = parts[2];
        const eventId = parts[3];
        const waveId = parts[4];
        const index = Number(selected);
        const event = getEvent(eventId);
        const wave = getWave(eventId, waveId);

        if (
          !event ||
          !wave ||
          !Number.isInteger(index) ||
          index < 0
        ) {
          return interaction.update({
            content: "Event, wave or selection not found.",
            components: []
          });
        }

        if (action === "remove") {
          const keys = Object.keys(wave.attendees || {});
          const key = keys[index];

          if (key === undefined) {
            return interaction.update({
              content: "Attendee not found. Please reopen the menu.",
              components: [waveActionsMenu(eventId, waveId)]
            });
          }

          delete wave.attendees[key];
          promoteFirstFit(wave);
          saveData();
          await refreshPanel(eventId, waveId);

          return interaction.update({
            content: "Attendee removed from this wave.",
            components: [waveActionsMenu(eventId, waveId)]
          });
        }

        if (action === "promote") {
          if (!promoteWaitingEntry(wave, index)) {
            return interaction.update({
              content: "This entry could not be promoted because there may not be enough space.",
              components: [waveActionsMenu(eventId, waveId)]
            });
          }

          saveData();
          await refreshPanel(eventId, waveId);

          return interaction.update({
            content: "Entry promoted to confirmed attendees.",
            components: [waveActionsMenu(eventId, waveId)]
          });
        }
      }
    }

    // Modal submissions
    if (interaction.isModalSubmit()) {
      const id = interaction.customId;

      if (id.startsWith("ppgform:")) {
        if (!isPPGAdmin(interaction) && !id.startsWith("ppgform:signup:")) {
          return interaction.reply({
            content: "You do not have permission to use this panel.",
            flags: MessageFlags.Ephemeral
          });
        }
      }

      // Create event
      if (id === "ppgform:create-event") {
        const name = interaction.fields.getTextInputValue("name").trim();
        const typeInput = interaction.fields.getTextInputValue("type").trim().toLowerCase();
        const hostName = interaction.fields.getTextInputValue("host").trim();
        const cohost1Name = interaction.fields.getTextInputValue("cohost1").trim();
        const cohost2Name = interaction.fields.getTextInputValue("cohost2").trim();

        const typeMap = {
          "200": "200 Sponty",
          "200 sponty": "200 Sponty",
          "400": "400 Gems",
          "400 gems": "400 Gems",
          "600": "600 Gems",
          "600 gems": "600 Gems",
          "1k": "1K Gems",
          "1k gems": "1K Gems",
          "1000": "1K Gems",
          "1000 gems": "1K Gems"
        };

        const type = typeMap[typeInput];

        if (!name || !type || !hostName) {
          return interaction.reply({
            content: "Enter an event name, valid event type (200, 400, 600 or 1K), and host name.",
            flags: MessageFlags.Ephemeral
          });
        }

        const eventId = makeId();
        const wave = createWave("Wave 1", interaction.channelId);

        db.events[eventId] = {
          id: eventId,
          name,
          type,
          hostName,
          cohost1Name,
          cohost2Name,
          createdBy: interaction.user.id,
          createdAt: Date.now(),
          ended: false,
          waves: { [wave.id]: wave }
        };

        saveData();

        await interaction.reply({
          content: `Created **${name}** (${type}). Posting the signup panel now.`,
          flags: MessageFlags.Ephemeral
        });

        await postPanel(interaction.channel, eventId, wave.id);
        return;
      }

      // Create wave
      if (id.startsWith("ppgform:create-wave:")) {
        const eventId = id.split(":")[2];
        const event = getEvent(eventId);

        if (!event || event.ended) {
          return interaction.reply({
            content: "That event no longer exists or has ended.",
            flags: MessageFlags.Ephemeral
          });
        }

        const name = interaction.fields.getTextInputValue("name").trim();

        if (!name) {
          return interaction.reply({
            content: "Please enter a wave name.",
            flags: MessageFlags.Ephemeral
          });
        }

        const wave = createWave(name, interaction.channelId);
        event.waves[wave.id] = wave;
        saveData();

        await interaction.reply({
          content: `Created **${name}** for **${event.name}**.`,
          flags: MessageFlags.Ephemeral
        });

        await postPanel(interaction.channel, eventId, wave.id);
        return;
      }

      // Manually add attendee or guest
      if (id.startsWith("ppgform:add:")) {
        const [, , eventId, waveId] = id.split(":");
        const event = getEvent(eventId);
        const wave = getWave(eventId, waveId);

        if (!event || !wave || event.ended) {
          return interaction.reply({
            content: "That event or wave could not be found or has ended.",
            flags: MessageFlags.Ephemeral
          });
        }

        const memberId = interaction.fields.getTextInputValue("memberid").trim();
        const ign = interaction.fields.getTextInputValue("ign").trim();
        const tag = interaction.fields.getTextInputValue("tag").trim();
        const friendIgn = interaction.fields.getTextInputValue("friendign").trim();
        const friendTag = interaction.fields.getTextInputValue("friendtag").trim();

        if (!ign || !tag) {
          return interaction.reply({
            content: "Enter the guest/member IGN and in-game tag.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (memberId && !/^\d{17,20}$/.test(memberId)) {
          return interaction.reply({
            content: "If provided, the Discord ID must contain 17–20 digits.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (Boolean(friendIgn) !== Boolean(friendTag)) {
          return interaction.reply({
            content: "For a friend signup, provide both the friend's IGN and tag.",
            flags: MessageFlags.Ephemeral
          });
        }

        const allEntries = [
          ...Object.values(wave.attendees || {}),
          ...(wave.waitlist || [])
        ];

        if (
          memberId &&
          allEntries.some(entry => entry.userId === memberId)
        ) {
          return interaction.reply({
            content: "That Discord user is already signed up for this wave.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (allEntries.some(entry =>
          entry.ign?.toLowerCase() === ign.toLowerCase() &&
          (entry.gameTag || entry.tag || "").toLowerCase() === tag.toLowerCase()
        )) {
          return interaction.reply({
            content: "That IGN and tag are already on this wave's list.",
            flags: MessageFlags.Ephemeral
          });
        }

        const result = enqueueOrConfirm(wave, {
          userId: memberId || null,
          ign,
          gameTag: tag,
          tag,
          friendIgn,
          friendTag,
          signedUpAt: new Date().toISOString(),
          manuallyAddedBy: interaction.user.id
        });

        if (!result.ok) {
          return interaction.reply({
            content: result.message,
            flags: MessageFlags.Ephemeral
          });
        }

        saveData();
        await refreshPanel(eventId, waveId);

        return interaction.reply({
          content: `Added **${ign}**. Status: **${result.status}**.`,
          flags: MessageFlags.Ephemeral
        });
      }

      // Public signup
      if (id.startsWith("ppgform:signup:")) {
        const [, , eventId, waveId] = id.split(":");
        const event = getEvent(eventId);
        const wave = getWave(eventId, waveId);

        if (!event || !wave || event.ended || !wave.open) {
          return interaction.reply({
            content: "Signups for this event wave are closed.",
            flags: MessageFlags.Ephemeral
          });
        }

        const ign = interaction.fields.getTextInputValue("ign").trim();
        const tag = interaction.fields.getTextInputValue("gametag").trim();
        const friendAnswer = interaction.fields.getTextInputValue("friend").trim().toLowerCase();
        const friendIgn = interaction.fields.getTextInputValue("friendign").trim();
        const friendTag = interaction.fields.getTextInputValue("friendtag").trim();

        if (!ign || !tag) {
          return interaction.reply({
            content: "Please enter both your in-game name and tag.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (!["yes", "no"].includes(friendAnswer)) {
          return interaction.reply({
            content: "For the friend question, enter YES or NO.",
            flags: MessageFlags.Ephemeral
          });
        }

        const hasFriend = friendAnswer === "yes";

        if (hasFriend && (!friendIgn || !friendTag)) {
          return interaction.reply({
            content: "You selected YES, so provide your friend's IGN and tag.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (!hasFriend && (friendIgn || friendTag)) {
          return interaction.reply({
            content: "You selected NO, so leave the friend's IGN and tag blank.",
            flags: MessageFlags.Ephemeral
          });
        }

        const allEntries = [
          ...Object.values(wave.attendees || {}),
          ...(wave.waitlist || [])
        ];

        if (allEntries.some(entry => entry.userId === interaction.user.id)) {
          return interaction.reply({
            content: "You are already signed up for this wave.",
            flags: MessageFlags.Ephemeral
          });
        }

        const result = enqueueOrConfirm(wave, {
          userId: interaction.user.id,
          ign,
          gameTag: tag,
          tag,
          friendIgn: hasFriend ? friendIgn : "",
          friendTag: hasFriend ? friendTag : "",
          signedUpAt: new Date().toISOString()
        });

        if (!result.ok) {
          return interaction.reply({
            content: result.message,
            flags: MessageFlags.Ephemeral
          });
        }

        saveData();
        await refreshPanel(eventId, waveId);

        return interaction.reply({
          content: result.status === "confirmed"
            ? `You're confirmed, **${ign}**, for **${event.name} — ${wave.name}**!`
            : `You're on the waiting list, **${ign}**, for **${event.name} — ${wave.name}**.`,
          flags: MessageFlags.Ephemeral
        });
      }
    }
  } catch (error) {
    console.error("PPG interaction error:", error);

    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "Something went wrong while processing that action. Please try again or contact an admin.",
        flags: MessageFlags.Ephemeral
      }).catch(() => {});
    }
  }
});

// ==================================================
// START BOT
// ==================================================

async function start() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log("Registered the single /ppg command.");

  await client.login(TOKEN);
}

start().catch(error => {
  console.error("PPG bot startup failed:", error);
  process.exit(1);
});
