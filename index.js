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
const CONFIRM_TIMEOUT = 10 * 60 * 1000;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  throw new Error("Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID.");
}

fs.mkdirSync(DATA_DIR, { recursive: true });

function short(value, max = 80) {
  return String(value ?? "").trim().slice(0, max);
}

function makeId() {
  return crypto.randomBytes(4).toString("hex");
}

function readData() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { events: {} };
    }

    return data;
  } catch (error) {
    if (error.code === "ENOENT") return { events: {} };
    throw error;
  }
}


function saveData() {
  const temp = `${DATA_FILE}.tmp`;

  fs.writeFileSync(temp, JSON.stringify(db, null, 2), {
    mode: 0o600
  });

  fs.renameSync(temp, DATA_FILE);
}


let db = readData();

if (!db.events || typeof db.events !== "object" || Array.isArray(db.events)) {
  db = { events: {} };
}


 // Preserve saved events and normalise wave data.
for (const event of Object.values(db.events)) {
  if (!event.waves || typeof event.waves !== "object" || Array.isArray(event.waves)) {
    event.waves = {};
  }

  for (const wave of Object.values(event.waves)) {
    if (!Array.isArray(wave.attendees)) {
      wave.attendees = wave.attendees && typeof wave.attendees === "object"
        ? Object.values(wave.attendees)
        : [];
    }

    if (!Array.isArray(wave.waitlist)) {
      wave.waitlist = wave.waitlist && typeof wave.waitlist === "object"
        ? Object.values(wave.waitlist)
        : [];
    }

    for (const entry of wave.attendees) {
      entry.gameTag ||= entry.tag || "";
      entry.friendIgn ||= "";
      entry.friendTag ||= "";
    }

    for (const entry of wave.waitlist) {
      entry.gameTag ||= entry.tag || "";
      entry.friendIgn ||= "";
      entry.friendTag ||= "";
    }

    wave.open ??= false;
  }
}

saveData();

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const pending = new Map();

const eventTypes = [
  { name: "200 Sponty", value: "200 Sponty" },
  { name: "400 Gems", value: "400 Gems" },
  { name: "600 Gems", value: "600 Gems" },
  { name: "1K Gems", value: "1K Gems" }
];

// Register only one slash command: /ppg
const commands = [
  new SlashCommandBuilder()
    .setName("ppg")
    .setDescription("Open the PPG event management panel.")
    .setDefaultMemberPermissions(null)
    .toJSON()
];

function isPPGAdmin(interaction) {
  return interaction.member?.roles?.cache?.has(ADMIN_ROLE_ID) ?? false;
}

function getEvent(id) {
  return db.events[id];
}

function getWave(eventId, waveId) {
  return getEvent(eventId)?.waves?.[waveId];
}

function hostIds(event) {
  return [event.hostId, event.cohost1Id, event.cohost2Id];
}

function totalSeats(wave) {
  return Object.values(wave.attendees).reduce(
    (sum, entry) => sum + 1 + (entry.friendIgn ? 1 : 0),
    0
  );
}

function totalWaitingSeats(wave) {
  return wave.waitlist.reduce(
    (sum, entry) => sum + 1 + (entry.friendIgn ? 1 : 0),
    0
  );
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

function parseUserId(value) {
  const match = String(value || "").match(/\d{17,20}/);
  return match ? match[0] : null;
}

function entryFor(userId, ign, gameTag, friendIgn, friendTag, addedBy) {
  return {
    userId,
    ign: short(ign, 50),
    gameTag: short(gameTag, 50),
    friendIgn: short(friendIgn, 50),
    friendTag: short(friendTag, 50),
    addedBy,
    signedUpAt: new Date().toISOString()
  };
}

function seatsAvailable(wave, friendIgn) {
  return CAPACITY - totalSeats(wave) >= (friendIgn ? 2 : 1);
}


function enqueueOrConfirm(wave, entry) {
  if (
    !wave.attendees ||
    typeof wave.attendees !== "object" ||
    Array.isArray(wave.attendees)
  ) {
    wave.attendees = {};
  }

  if (!Array.isArray(wave.waitlist)) {
    wave.waitlist = [];
  }

  const size = 1 + (entry.friendIgn ? 1 : 0);

  if (
    totalSeats(wave) + size <= CAPACITY &&
    wave.waitlist.length === 0
  ) {
    wave.attendees[String(entry.userId)] = {
      ...entry,
      gameTag: entry.gameTag || entry.tag || ""
    };

    return { ok: true, status: "confirmed" };
  }

  if (wave.waitlist.length < WAITLIST_CAPACITY) {
    wave.waitlist.push({
      ...entry,
      gameTag: entry.gameTag || entry.tag || ""
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
  let changed = true;

  while (changed) {
    changed = false;

    const index = wave.waitlist.findIndex(
      entry => seatsAvailable(wave, entry.friendIgn)
    );

    if (index >= 0) {
      const entry = wave.waitlist.splice(index, 1)[0];
      wave.attendees[entry.userId] = entry;
      changed = true;
    }
  }
}

function promoteWaiting(wave, userId) {
  const index = wave.waitlist.findIndex(
    entry => entry.userId === userId
  );

  if (index < 0) return false;

  const entry = wave.waitlist[index];

  if (!seatsAvailable(wave, entry.friendIgn)) return false;

  wave.waitlist.splice(index, 1);
  wave.attendees[userId] = entry;

  return true;
}

function formatEntry(entry, index) {
  let text =
    `**${index + 1}.** <@${entry.userId}> — **${entry.ign}**` +
    (entry.gameTag ? ` | Tag: ${entry.gameTag}` : "");

  if (entry.friendIgn) {
    text += `\n   ↳ Friend: **${entry.friendIgn}**` +
      (entry.friendTag ? ` | Tag: ${entry.friendTag}` : "");
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
    .setColor(wave.open && !event.ended ? 0x238636 : 0x8b2635)
    .setTitle(`🎉 ${event.name.replace(/\s*[—–-]\s*[a-f0-9]{8}$/i, "").trim()}`)
    .setDescription(
      `**Type:** ${event.type}\n` +
      (event.dateText ? `**When:** ${event.dateText}\n` : "") +
      `**Host:** ${event.hostName || (event.hostId ? `<@${event.hostId}>` : "Not specified")}\n` +
      `**Co-hosts:** ${event.cohost1Name || (event.cohost1Id ? `<@${event.cohost1Id}>` : "Not specified")} and ${event.cohost2Name || (event.cohost2Id ? `<@${event.cohost2Id}>` : "Not specified")}\n\n` +
      `**Attendee places:** ${totalSeats(wave)}/${CAPACITY}\n` +
      `**Waiting list:** ${wave.waitlist.length}/${WAITLIST_CAPACITY}\n` +
      `**Signups:** ${wave.open && !event.ended ? "🟢 OPEN" : "🔴 CLOSED"}\n\n` +
      "**To sign up:** Press Sign Up and enter your IGN, Tag, " +
      "whether you are adding a friend, and your friend's IGN and Tag if applicable."
    )
    .setFooter({ text: "PPG Signup System 💜" });

  const attendees = Object.values(wave.attendees);

  if (attendees.length) {
    let text = "";

    for (const [i, entry] of attendees.entries()) {
      const line = formatEntry(entry, i);

      if ((text + "\n" + line).length > 1000) {
        text += "\n…";
        break;
      }

      text += (text ? "\n" : "") + line;
    }

    embed.addFields({
      name: "📋 Confirmed attendees",
      value: text || "No attendees yet."
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

async function postPanel(interaction, eventId, waveId) {
  if (!interaction.channel?.send) {
    throw new Error("Use this action in a text channel.");
  }

  const message = await interaction.channel.send(
    panelPayload(eventId, waveId)
  );

  const wave = getWave(eventId, waveId);
  wave.channelId = message.channelId;
  wave.messageId = message.id;

  saveData();
}

// ==================================================
// ADMIN MENU COMPONENTS
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

function eventMenu(customId = "ppg:select-event", max = 25) {
  const events = Object.values(db.events).slice(-max);

  if (!events.length) return null;

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder("Select an event")
      .addOptions(
        events.map(event => ({
          label: short(event.name, 100),
          description:
            `${event.type}${event.ended ? " • Ended" : ""}`.slice(0, 100),
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
        {
          label: "Ping all confirmed attendees",
          value: "ping",
          description: "Mention everyone confirmed for this wave",
          emoji: "📣"
        },
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
    : Object.values(wave.attendees);

  if (!entries.length) return null;

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ppg:member:${action}:${eventId}:${waveId}`)
      .setPlaceholder("Select a member")
      .addOptions(
        entries.slice(0, 25).map(entry => ({
          label: short(entry.ign || entry.userId, 100),
          description:
            action === "promote" ? "Waiting list" : "Confirmed attendee",
          value: entry.userId
        }))
      )
  );
}
// ==================================================
// EVENT CREATION MODALS
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
          .setRequired(true)
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

  const name = new TextInputBuilder()
    .setCustomId("name")
    .setLabel("Wave name")
    .setStyle(TextInputStyle.Short)
    .setMaxLength(40)
    .setRequired(true)
    .setPlaceholder("Wave 2");

  modal.addComponents(new ActionRowBuilder().addComponents(name));

  return modal;
}

function entryModal(eventId, waveId) {
  const modal = new ModalBuilder()
    .setCustomId(`ppgform:add:${eventId}:${waveId}`)
    .setTitle("Manually Add Attendee");

  const ign = new TextInputBuilder()
    .setCustomId("ign")
    .setLabel("Member IGN")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(50);

  const tag = new TextInputBuilder()
    .setCustomId("tag")
    .setLabel("Member in-game Tag")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(50);

  const friendIgn = new TextInputBuilder()
    .setCustomId("friendign")
    .setLabel("Friend IGN (optional)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(50);

  const friendTag = new TextInputBuilder()
    .setCustomId("friendtag")
    .setLabel("Friend Tag (optional)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(50);

  const memberId = new TextInputBuilder()
    .setCustomId("memberid")
    .setLabel("Discord member ID")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(30);

  modal.addComponents(
    new ActionRowBuilder().addComponents(ign),
    new ActionRowBuilder().addComponents(tag),
    new ActionRowBuilder().addComponents(friendIgn),
    new ActionRowBuilder().addComponents(friendTag),
    new ActionRowBuilder().addComponents(memberId)
  );

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
      // Delete the signup panel.
      if (wave.channelId && wave.messageId) {
        try {
          const channel = await client.channels.fetch(wave.channelId);

          if (!channel?.messages) {
            allMessagesDeleted = false;
          } else {
            const message = await channel.messages.fetch(wave.messageId);
            await message.delete();
          }
        } catch (error) {
          if (error.code !== 10008) {
            console.error(
              `Could not delete signup panel for ${event.name}:`,
              error.message
            );
            allMessagesDeleted = false;
          }
        }
      }

      // Delete tracked reminder/ping messages.
      for (const ping of wave.pingMessages || []) {
        try {
          const channel = await client.channels.fetch(ping.channelId);

          if (!channel?.messages) {
            allMessagesDeleted = false;
            continue;
          }

          const message = await channel.messages.fetch(ping.messageId);
          await message.delete();
        } catch (error) {
          if (error.code !== 10008) {
            console.error(
              `Could not delete ping message for ${event.name}:`,
              error.message
            );
            allMessagesDeleted = false;
          }
        }
      }
    }

    // Keep the event and its records if any message could not be deleted.
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
// INTERACTION HANDLER — COMMANDS AND BUTTONS
// ==================================================

client.on("interactionCreate", async interaction => {
  try {
    // ------------------------------------------
    // /ppg COMMAND
    // ------------------------------------------

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== "ppg") return;

      if (!isPPGAdmin(interaction)) {
        return interaction.reply({
          content: "⛔ Only members with the Admin role can use this command.",
          flags: MessageFlags.Ephemeral
        });
      }

      return interaction.reply({
        content: "**🏛️ PPG Management Panel**\nChoose an action below.",
        components: mainMenu(),
        flags: MessageFlags.Ephemeral
      });
    }

    // ------------------------------------------
    // BUTTONS
    // ------------------------------------------

    if (interaction.isButton()) {
      if (!interaction.customId.startsWith("ppg:")) return;

      const parts = interaction.customId.split(":");
      const action = parts[1];

      // Admin panel buttons
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

          if (!row) {
            return interaction.reply({
              content: "Create an event first.",
              flags: MessageFlags.Ephemeral
            });
          }

          return interaction.reply({
            content: "Select the event for the new wave.",
            components: [row],
            flags: MessageFlags.Ephemeral
          });
        }

        if (action === "manage") {
          const row = eventMenu("ppg:manage-select");

          if (!row) {
            return interaction.reply({
              content: "There are no events yet. Select Create Event first.",
              flags: MessageFlags.Ephemeral
            });
          }

          return interaction.reply({
            content: "Select an event to manage.",
            components: [row],
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
            description:
              `${event.type}${event.ended ? " • Ended" : ""}`.slice(0, 100),
            value: event.id
          }));

          options.push({
            label: "ALL EVENTS",
            description: "Delete all events and signup records",
            value: "ALL"
          });

          const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("ppg:delete-select")
              .setPlaceholder("Select events to delete")
              .setMinValues(1)
              .setMaxValues(options.length)
              .addOptions(options)
          );

          return interaction.reply({
            content:
              "🗑️ **Delete Events**\nSelect events to delete. " +
              "You must confirm before permanent deletion.",
            components: [row],
            flags: MessageFlags.Ephemeral
          });
        }

        if (action === "stats") {
          const events = Object.values(db.events);
          const waves = events.flatMap(
            event => Object.values(event.waves || {})
          );

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

      // ------------------------------------------
      // PUBLIC SIGNUP / CANCELLATION BUTTONS
      // ------------------------------------------

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

      // Prevent old events' Discord-ID hosts from taking attendee places.
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
        // ==========================================
    // SELECT MENUS
    // ==========================================

    if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;
      const selected = interaction.values[0];

      if (id.startsWith("ppg:") && !isPPGAdmin(interaction)) {
        return interaction.reply({
          content: "⛔ Administrator permission is required.",
          flags: MessageFlags.Ephemeral
        });
      }

      // Select an event for creating a wave
      if (id === "ppg:create-wave-select") {
        const event = getEvent(selected);

        if (!event) {
          return interaction.update({
            content: "Event not found.",
            components: []
          });
        }

        return interaction.showModal(createWaveModal(selected));
      }

      // Select an event to manage
      if (id === "ppg:manage-select") {
        const event = getEvent(selected);
        const row = waveMenu(selected);

        if (!event || !row) {
          return interaction.update({
            content: "Event or waves not found.",
            components: []
          });
        }

        return interaction.update({
          content: `**${event.name}** — select a wave.`,
          components: [row]
        });
      }

      // Select a wave
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

      // Select event(s) for deletion
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

        pending.set(key, {
          userId: interaction.user.id,
          eventIds: ids,
          createdAt: Date.now()
        });

        const names = ids
          .map(eventId => `• ${getEvent(eventId).name}`)
          .join("\n");

        return interaction.update({
          content:
            `⚠️ **Confirm permanent deletion**\n\n` +
            `${names.slice(0, 1100)}\n\n` +
            `This deletes ${ids.length} event(s), their waves and signup records. This cannot be undone.`,
          components: [confirmationMenu(`ppg:delete-confirm:${key}`)]
        });
      }

      // Confirm or cancel deletion
      if (id.startsWith("ppg:delete-confirm:")) {
        const key = id.split(":")[2];
        const item = pending.get(key);

        if (
          !item ||
          item.userId !== interaction.user.id ||
          Date.now() - item.createdAt > CONFIRM_TIMEOUT
        ) {
          pending.delete(key);

          return interaction.update({
            content: "Confirmation expired. Open Delete Events again.",
            components: []
          });
        }

        pending.delete(key);

        if (selected !== "yes") {
          return interaction.update({
            content: "Deletion cancelled. No events were deleted.",
            components: []
          });
        }

        const ids = item.eventIds.filter(eventId => getEvent(eventId));
        const result = await deleteEvents(ids);

        let message =
          `🗑️ Successfully deleted ${result.deleted.length} event(s) and their saved signup records.`;

        if (result.failed.length) {
          message +=
            "\n\n⚠️ These events were kept because a signup panel could not be deleted:\n" +
            result.failed.map(name => `• ${name}`).join("\n");
        }

        return interaction.update({
          content: message.slice(0, 1900),
          components: []
        });
      }

      // Confirm event cancellation
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
          content:
            `🔴 **${event.name} cancelled.** All waves are closed and records are preserved.`,
          components: []
        });
      }

      // Wave action selection
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
            content:
              `⚠️ Cancel **${event.name}** and close every wave? ` +
              "Attendee and waiting-list records will be kept.",
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
          const message = await interaction.channel.send(
            panelPayload(eventId, waveId)
          );

          wave.channelId = message.channelId;
          wave.messageId = message.id;
          saveData();

          return interaction.update({
            content: "New signup panel posted.",
            components: [waveActionsMenu(eventId, waveId)]
          });
        }

        
        if (selected === "ping") {
          const attendeeIds = Object.keys(wave.attendees || {});

          if (!attendeeIds.length) {
            return interaction.update({
              content: "There are no confirmed attendees to ping.",
              components: [waveActionsMenu(eventId, waveId)]
            });
          }

          const batches = [];

          for (let i = 0; i < attendeeIds.length; i += 40) {
            batches.push(attendeeIds.slice(i, i + 40));
          }

          await interaction.update({
            content: `📣 Sending a ping to ${attendeeIds.length} confirmed attendee(s)…`,
            components: [waveActionsMenu(eventId, waveId)]
          });

          for (const batch of batches) {
            const pingMessage = await interaction.channel.send({
              content:
                `📣 **PPG Event Reminder — ${event.name} | ${wave.name}**\n` +
                batch.map(userId => `<@${userId}>`).join(" "),
              allowedMentions: {
                users: batch,
                parse: []
              }
            });

            if (!Array.isArray(wave.pingMessages)) {
              wave.pingMessages = [];
            }

            wave.pingMessages.push({
              channelId: pingMessage.channelId,
              messageId: pingMessage.id
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
            "Discord User ID",
            "IGN",
            "In-Game Tag",
            "Friend IGN",
            "Friend Tag",
            "Status",
            "Signed Up At"
          ]];

          for (const a of Object.values(wave.attendees)) {
            rows.push([
              a.userId, a.ign, a.gameTag, a.friendIgn,
              a.friendTag, "Confirmed", a.signedUpAt
            ]);
          }

          for (const a of wave.waitlist) {
            rows.push([
              a.userId, a.ign, a.gameTag, a.friendIgn,
              a.friendTag, "Waiting list", a.signedUpAt
            ]);
          }

          const csv = rows
            .map(row => row.map(cell).join(","))
            .join("\n");

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
            : Object.values(wave.attendees);

          if (!entries.length) {
            return interaction.update({
              content: selected === "waitlist"
                ? "Waiting list is empty."
                : "No confirmed attendees.",
              components: [waveActionsMenu(eventId, waveId)]
            });
          }

          return interaction.update({
            content: entries
              .map((entry, i) => formatEntry(entry, i))
              .join("\n")
              .slice(0, 1800),
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
              ? "Select the waiting-list member to promote."
              : "Select the confirmed attendee to remove.",
            components: [row]
          });
        }
      }

      // Select attendee to remove or promote
      if (id.startsWith("ppg:member:")) {
        const parts = id.split(":");
        const action = parts[2];
        const eventId = parts[3];
        const waveId = parts[4];
        const userId = selected;
        const event = getEvent(eventId);
        const wave = getWave(eventId, waveId);

        if (!event || !wave) {
          return interaction.update({
            content: "Event or wave not found.",
            components: []
          });
        }

        if (action === "remove") {
          if (wave.attendees[userId]) {
            delete wave.attendees[userId];
            promoteFirstFit(wave);
          } else {
            const index = wave.waitlist.findIndex(
              entry => entry.userId === userId
            );

            if (index >= 0) {
              wave.waitlist.splice(index, 1);
            } else {
              return interaction.update({
                content: "Member not found.",
                components: []
              });
            }
          }

          saveData();
          await refreshPanel(eventId, waveId);

          return interaction.update({
            content: "Member removed from this wave.",
            components: [waveActionsMenu(eventId, waveId)]
          });
        }

        if (action === "promote") {
          if (!promoteWaiting(wave, userId)) {
            return interaction.update({
              content:
                "Member could not be promoted; there may not be room for their entire signup.",
              components: [waveActionsMenu(eventId, waveId)]
            });
          }

          saveData();
          await refreshPanel(eventId, waveId);

          return interaction.update({
            content: "Member promoted to confirmed attendees.",
            components: [waveActionsMenu(eventId, waveId)]
          });
        }
      }
    }
    
    // MODAL SUBMISSIONS
    if (interaction.isModalSubmit()) {
      const id = interaction.customId;

      // CREATE EVENT
      if (id === "ppgform:create-event") {
        if (!isPPGAdmin(interaction)) {
          return interaction.reply({
            content: "You do not have permission to use this panel.",
            ephemeral: true
          });
        }

        const name = interaction.fields.getTextInputValue("name").trim();
        const cleanName = name.replace(/\s*[—–-]\s*[a-f0-9]{8}$/i, "").trim();
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

        const eventType = typeMap[typeInput];

        if (!name || !eventType || !hostName) {
          return interaction.reply({
            content: "Please provide an event name, a valid event type (200, 400, 600 or 1K), and a host name.",
            ephemeral: true
          });
        }

        const eventId = crypto.randomBytes(4).toString("hex");
        const wave = createWave(eventId, "Wave 1", interaction.channelId);

        db.events[eventId] = {
          id: eventId,
          name: cleanName,
          type: eventType,
          hostName,
          cohost1Name,
          cohost2Name,
          createdBy: interaction.user.id,
          createdAt: Date.now(),
          ended: false,
          waves: {
            [wave.id]: wave
          }
        };

        saveData();

        await interaction.reply({
          content: `Created **${name}** (${eventType}). Posting the signup panel now.`,
          ephemeral: true
        });

        await postPanel(interaction, eventId, wave.id);
        return;
      }

      // CREATE WAVE
      if (id === "ppgform:create-wave") {
        if (!isPPGAdmin(interaction)) {
          return interaction.reply({
            content: "You do not have permission to use this panel.",
            ephemeral: true
          });
        }

        const eventId = pending.get(interaction.user.id);
        const event = getEvent(eventId);

        if (!event || event.ended) {
          return interaction.reply({
            content: "That event no longer exists or has been cancelled.",
            ephemeral: true
          });
        }

        const waveName = interaction.fields.getTextInputValue("name").trim();

        if (!waveName) {
          return interaction.reply({
            content: "Please enter a wave name.",
            ephemeral: true
          });
        }

        const wave = createWave(eventId, waveName, interaction.channelId);
        event.waves[wave.id] = wave;
        saveData();

        await interaction.reply({
          content: `Created **${waveName}** for **${event.name}**.`,
          ephemeral: true
        });

        await postPanel(interaction, eventId, wave.id);
        return;
      }

      // MANUALLY ADD AN ATTENDEE
      if (id.startsWith("ppgform:add:")) {
        if (!isPPGAdmin(interaction)) {
          return interaction.reply({
            content: "You do not have permission to use this panel.",
            ephemeral: true
          });
        }

        const [, , eventId, waveId] = id.split(":");
        const event = getEvent(eventId);
        const wave = getWave(eventId, waveId);

        if (!event || !wave || event.ended) {
          return interaction.reply({
            content: "That event or wave could not be found.",
            ephemeral: true
          });
        }

        const memberId = interaction.fields.getTextInputValue("memberid").trim();
        const ign = interaction.fields.getTextInputValue("ign").trim();
        const tag = interaction.fields.getTextInputValue("tag").trim();
        const friendIgn = interaction.fields.getTextInputValue("friendign").trim();
        const friendTag = interaction.fields.getTextInputValue("friendtag").trim();

        if (!/^\d{17,20}$/.test(memberId) || !ign || !tag) {
          return interaction.reply({
            content: "Enter a valid Discord user ID, IGN and in-game tag.",
            ephemeral: true
          });
        }

        if (Boolean(friendIgn) !== Boolean(friendTag)) {
          return interaction.reply({
            content: "For a friend signup, provide both the friend's IGN and tag.",
            ephemeral: true
          });
        }
const allEntries = [
  ...Object.values(wave.attendees || {}),
  ...wave.waitlist
];

        if (allEntries.some(entry => entry.userId === memberId)) {
          return interaction.reply({
            content: "That Discord user is already signed up for this wave.",
            ephemeral: true
          });
        }

        const result = enqueueOrConfirm(wave, {
          userId: memberId,
          ign,
          tag,
          friend: Boolean(friendIgn),
          friendIgn,
          friendTag,
          signedUpAt: Date.now(),
          manuallyAddedBy: interaction.user.id
        });

        if (!result.ok) {
          return interaction.reply({
            content: result.message || "There is no available space or waiting-list slot.",
            ephemeral: true
          });
        }

        saveData();
        await refreshPanel(eventId, waveId);

        return interaction.reply({
          content: `Added **${ign}**. Status: **${result.status}**.`,
          ephemeral: true
        });
      }

      // PUBLIC SIGNUP FORM
      if (id.startsWith("ppgform:signup:")) {
        const [, , eventId, waveId] = id.split(":");
        const event = getEvent(eventId);
        const wave = getWave(eventId, waveId);

        if (!event || !wave || event.ended || !wave.open) {
          return interaction.reply({
            content: "Signups for this event wave are closed.",
            ephemeral: true
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
            ephemeral: true
          });
        }

        if (!["yes", "no"].includes(friendAnswer)) {
          return interaction.reply({
            content: "For the friend question, enter YES or NO.",
            ephemeral: true
          });
        }

        const hasFriend = friendAnswer === "yes";

        if (hasFriend && (!friendIgn || !friendTag)) {
          return interaction.reply({
            content: "You selected YES, so please provide your friend's IGN and tag.",
            ephemeral: true
          });
        }

        if (!hasFriend && (friendIgn || friendTag)) {
          return interaction.reply({
            content: "You selected NO, so leave the friend's IGN and tag blank.",
            ephemeral: true
          });
        }

        const allEntries = [
  ...Object.values(wave.attendees || {}),
  ...(Array.isArray(wave.waitlist) ? wave.waitlist : [])
];

        if (allEntries.some(entry => entry.userId === interaction.user.id)) {
          return interaction.reply({
            content: "You are already signed up for this wave.",
            ephemeral: true
          });
        }

        const result = enqueueOrConfirm(wave, {
          userId: interaction.user.id,
          ign,
          tag,
          friend: hasFriend,
          friendIgn: hasFriend ? friendIgn : "",
          friendTag: hasFriend ? friendTag : "",
          signedUpAt: Date.now()
        });

        if (!result.ok) {
          return interaction.reply({
            content: result.message || "There are no available places or waiting-list slots.",
            ephemeral: true
          });
        }

        saveData();
        await refreshPanel(eventId, waveId);

        return interaction.reply({
  content: result.status === "confirmed"
    ? `You're confirmed, **${ign}**, for **${event.name} — ${wave.name}**!`
    : `You're on the waiting list, **${ign}**, for **${event.name} — ${wave.name}**.`,
  ephemeral: true
});
      }
    }
  } catch (error) {
    console.error("PPG interaction error:", error);

    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "Something went wrong while processing that action. Please try again or contact an admin.",
        ephemeral: true
      }).catch(() => {});
    }
  }
});

// Register the single /ppg command and start the bot.
async function start() {
  if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
    throw new Error("Missing DISCORD_TOKEN, CLIENT_ID or GUILD_ID environment variable.");
  }

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
