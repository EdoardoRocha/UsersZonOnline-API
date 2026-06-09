import "dotenv/config";
import cors from "cors";
import express from "express";
import mongoose, { Schema } from "mongoose";
import { EventEmitter } from "events";
import axios from "axios";
import { waitUntil } from "@vercel/functions";
import { connectDB } from "./db.js";

const app = express();
EventEmitter.defaultMaxListeners = 20;

const ROTA_GROUP = "rota";

const COMPOSITE_ROUTES = {
  "digital-purificador": {
    slug: "digital-purificador",
    label: "Digital + Purificador",
    sourceSlugs: ["digital", "purificador"],
    distributionType: "queue",
    sortOrder: 100,
  },
  "digital-ef": {
    slug: "digital-ef",
    label: "Digital + Elemento filtrante",
    sourceSlugs: ["digital", "ef"],
    distributionType: "queue",
    sortOrder: 101,
  },
  "purificador-ef": {
    slug: "purificador-ef",
    label: "Purificador + Elemento filtrante",
    sourceSlugs: ["purificador", "ef"],
    distributionType: "queue",
    sortOrder: 102,
  },
};

const indexPointers = {};

const DEFAULT_PLUGIN_GROUPS = [
  {
    slug: "digital",
    label: "Digital",
    distributionType: "instant",
    sortOrder: 0,
    members: [
      { userId: "12610415", name: "Andressa Santos" },
      { userId: "12610431", name: "Laissa Ramalho" },
      { userId: "12610447", name: "Mayra Coutinho" },
      { userId: "12610451", name: "Tamyres Barradas" },
      { userId: "12610455", name: "Viviane Andrade" },
    ],
  },
  {
    slug: "sac",
    label: "SAC",
    distributionType: "instant",
    sortOrder: 1,
    members: [
      { userId: "13763631", name: "Mara Rayane" },
      { userId: "13763723", name: "Vitória Almada" },
      { userId: "13899999", name: "Daniela Silva" },
      { userId: "15064392", name: "Amanda Oliveira" },
    ],
  },
  {
    slug: "vipzon",
    label: "VipZon",
    distributionType: "instant",
    sortOrder: 2,
    members: [
      { userId: "14070208", name: "Beatriz Araújo" },
      { userId: "12622183", name: "Erika Costa" },
      { userId: "15118328", name: "Geovana Rodrigues" },
    ],
  },
  {
    slug: "ef",
    label: "Elemento filtrante",
    distributionType: "instant",
    sortOrder: 3,
    members: [
      { userId: "14134368", name: "Leila Ricardo" },
      { userId: "14067216", name: "Vânia Ricardo" },
      { userId: "12619255", name: "Andressa Silva" },
      { userId: "12619203", name: "Adriane Aragão" },
      { userId: "12619263", name: "Flaviana Sousa" },
      { userId: "12619251", name: "Carla Maria" },
      { userId: "12619235", name: "Thatyana Mesquita" },
      { userId: "12970851", name: "Eduarda Peixoto" },
      { userId: "12619131", name: "Aryane Aguiar" },
      { userId: "12619147", name: "Thalita Araújo" },
      { userId: "12619175", name: "Samara Lourenço" },
      { userId: "12619215", name: "Neusa Rodrigues" },
      { userId: "14577504", name: "Dênise Sousa" },
    ],
  },
  {
    slug: "pos-venda",
    label: "Pós-venda",
    distributionType: "instant",
    sortOrder: 4,
    members: [
      { userId: "15118328", name: "Geovana Rodrigues" },
      { userId: "12622183", name: "Erika Costa" },
    ],
  },
  {
    slug: "rota",
    label: "Rota",
    distributionType: "queue",
    sortOrder: 5,
    members: [
      { userId: "14107476", name: "Claudia Lacerda" },
      { userId: "14107552", name: "Maria Gislayne" },
      { userId: "15118328", name: "Geovana Rodrigues" },
    ],
  },
  {
    slug: "purificador",
    label: "Purificador",
    distributionType: "queue",
    sortOrder: 6,
    members: [
      { userId: "12619271", name: "Andréa Lins" },
      { userId: "12619287", name: "Angélica Ferreira" },
      { userId: "12619299", name: "Adriana Guerra" },
      { userId: "12619295", name: "Tânia Guerra" },
    ],
  },
];

function slugifyLabel(label) {
  return label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function isValidSlug(slug) {
  return typeof slug === "string" && /^[a-z0-9-]+$/.test(slug);
}

function isValidKommoUserId(userId) {
  return typeof userId === "string" && /^\d+$/.test(userId) && Number(userId) > 0;
}

let seedPromise = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractLeadFromBody(body) {
  return body.leads?.add?.[0] || body.leads?.status?.[0];
}

function getCompositeRoute(slug) {
  return COMPOSITE_ROUTES[slug] ?? null;
}

function resolveRouteLabel(slug) {
  return getCompositeRoute(slug)?.label ?? slug;
}

function isInvalidKommoUser(error) {
  return error.response?.data?.["validation-errors"]?.[0]?.errors?.some(
    (e) => e.path === "responsible_user_id" && e.code === "NotSupportedChoice",
  );
}

function scheduleBackgroundWork(promise) {
  try {
    waitUntil(promise);
  } catch {
    promise.catch((err) => console.error("[background]", err));
  }
}

// Schema
const OnlineUser = mongoose.model(
  "OnlineUsers",
  new Schema(
    {
      _id: {
        type: String,
        require: true,
      },
      name: {
        type: String,
      },
      status: {
        type: String,
        enum: ["online", "offline"],
        default: "offline",
        index: true,
      },
      groups: {
        type: [String],
        default: [],
        index: true,
      },
    },
    { timestamps: true },
  ),
);

const distributionJobSchema = new Schema(
  {
    leadId: { type: Number, required: true, index: true },
    group: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ["pending", "processing", "done", "failed"],
      default: "pending",
      index: true,
    },
    assignedTo: { type: String },
    error: { type: String },
  },
  { timestamps: true },
);

distributionJobSchema.index({ group: 1, status: 1, createdAt: 1 });
distributionJobSchema.index(
  { leadId: 1, group: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } },
);

const DistributionJob = mongoose.model("DistributionJob", distributionJobSchema);

const DistributionState = mongoose.model(
  "DistributionState",
  new Schema({
    _id: { type: String, required: true },
    pointer: { type: Number, default: 0 },
  }),
);

const DistributionLock = mongoose.model(
  "DistributionLock",
  new Schema({
    _id: { type: String, required: true },
    lockedUntil: { type: Date, default: () => new Date(0) },
  }),
);

const PluginGroup = mongoose.model(
  "PluginGroup",
  new Schema(
    {
      slug: { type: String, required: true, unique: true, index: true },
      label: { type: String, required: true },
      members: [
        {
          userId: { type: String, required: true },
          name: { type: String, required: true },
        },
      ],
      distributionType: {
        type: String,
        enum: ["instant", "queue"],
        default: "instant",
      },
      sortOrder: { type: Number, default: 0 },
      active: { type: Boolean, default: true },
    },
    { timestamps: true },
  ),
);

async function seedDefaultGroups() {
  const count = await PluginGroup.countDocuments();
  if (count > 0) return;

  await PluginGroup.insertMany(DEFAULT_PLUGIN_GROUPS);
  console.log("[seed] Grupos padrão inseridos.");
}

async function ensureMissingDefaultGroups() {
  for (const def of DEFAULT_PLUGIN_GROUPS) {
    await PluginGroup.updateOne(
      { slug: def.slug },
      {
        $setOnInsert: {
          slug: def.slug,
          label: def.label,
          distributionType: def.distributionType,
          sortOrder: def.sortOrder,
          members: def.members,
          active: true,
        },
      },
      { upsert: true },
    );
  }
}

async function ensureSeeded() {
  if (!seedPromise) {
    seedPromise = (async () => {
      await seedDefaultGroups();
      await ensureMissingDefaultGroups();
    })();
  }
  await seedPromise;
}

async function getActiveGroup(slug) {
  return PluginGroup.findOne({ slug, active: true });
}

async function groupExists(slug) {
  const group = await PluginGroup.findOne({ slug, active: true }).select("_id");
  return !!group;
}

function formatGroupResponse(group) {
  return {
    slug: group.slug,
    label: group.label,
    distributionType: group.distributionType,
    sortOrder: group.sortOrder,
    members: (group.members ?? []).map((m) => ({
      userId: m.userId,
      name: m.name,
    })),
  };
}

function formatCompositeGroupResponse(composite) {
  return {
    slug: composite.slug,
    label: composite.label,
    distributionType: composite.distributionType,
    sortOrder: composite.sortOrder,
    members: [],
    composite: true,
    sourceSlugs: composite.sourceSlugs,
  };
}

const DistributionLog = mongoose.model(
  "DistributionLog",
  new Schema(
    {
      type: {
        type: String,
        enum: [
          "kommo_error",
          "server_error",
          "queue_failed",
          "no_users_online",
          "enqueue_error",
          "kommo_user_skipped",
        ],
        required: true,
        index: true,
      },
      group: { type: String, index: true },
      leadId: { type: Number, index: true },
      message: { type: String, required: true },
      details: { type: Schema.Types.Mixed },
    },
    { timestamps: true },
  ),
);

DistributionLog.schema.index({ group: 1, createdAt: -1 });

async function writeDistributionLog({
  type,
  group,
  leadId,
  message,
  details,
}) {
  try {
    await DistributionLog.create({
      type,
      group,
      leadId: leadId != null ? Number(leadId) : undefined,
      message,
      details,
    });
  } catch (err) {
    console.error("[log] Falha ao gravar DistributionLog:", err.message);
  }
}

function summarizeKommoError(error) {
  if (typeof error === "string") {
    try {
      const parsed = JSON.parse(error);
      return parsed.detail || parsed.title || error;
    } catch {
      return error;
    }
  }
  return error?.detail || error?.title || "Erro desconhecido no Kommo";
}

async function getOnlineValidUsers(groupSlug) {
  const onlineUsers = await OnlineUser.find({
    groups: groupSlug,
    status: "online",
  }).sort({ createdAt: -1 });

  return onlineUsers.filter(
    (u) => u._id && Number.isInteger(Number(u._id)) && Number(u._id) > 0,
  );
}

async function getCombinedOnlineUsers(sourceSlugs) {
  const combined = [];
  const seen = new Set();

  for (const slug of sourceSlugs) {
    const users = await getOnlineValidUsers(slug);
    for (const user of users) {
      if (seen.has(user._id)) continue;
      seen.add(user._id);
      combined.push({ ...user.toObject(), _sourceGroup: slug });
    }
  }

  return combined;
}

async function getValidUsersForRoute(routeSlug) {
  const composite = getCompositeRoute(routeSlug);
  if (composite) {
    return getCombinedOnlineUsers(composite.sourceSlugs);
  }
  return getOnlineValidUsers(routeSlug);
}

function getNoUsersOnlineMessage(routeSlug) {
  const composite = getCompositeRoute(routeSlug);
  if (composite) {
    return `Nenhum usuário online nos grupos ${composite.sourceSlugs.join(", ")}`;
  }
  return `Nenhum usuário online no grupo ${routeSlug}`;
}

async function removeUserFromGroup(userId, groupSlug) {
  const updated = await OnlineUser.findOneAndUpdate(
    { _id: String(userId) },
    { $pull: { groups: groupSlug } },
    { returnDocument: "after" },
  );

  if (updated && updated.groups.length === 0) {
    await OnlineUser.findByIdAndUpdate(String(userId), { status: "offline" });
  }
}

async function getNextAttendant(groupSlug, validUsers) {
  const state = await DistributionState.findOneAndUpdate(
    { _id: groupSlug },
    { $inc: { pointer: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  const index = (state.pointer - 1) % validUsers.length;
  return validUsers[index];
}

function getKommoHeaders() {
  return {
    Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };
}

async function patchKommoEntities(resource, items) {
  const SUBDOMAIN = process.env.SUBDOMAIN;
  const maxRetries = 3;

  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      await axios.patch(
        `https://${SUBDOMAIN}.kommo.com/api/v4/${resource}`,
        items,
        { headers: getKommoHeaders() },
      );
      return;
    } catch (error) {
      if (error.response?.status === 429 && retry < maxRetries - 1) {
        await sleep(1000 * (retry + 1));
        continue;
      }
      throw error;
    }
  }
}

async function patchLeadInKommo(leadId, responsibleUserId) {
  await patchKommoEntities("leads", [
    {
      id: Number(leadId),
      responsible_user_id: Number(responsibleUserId),
    },
  ]);
}

async function patchContactsInKommo(contactIds, responsibleUserId) {
  if (!contactIds.length) return;

  await patchKommoEntities(
    "contacts",
    contactIds.map((id) => ({
      id: Number(id),
      responsible_user_id: Number(responsibleUserId),
    })),
  );
}

async function fetchLeadContactIds(leadId) {
  const SUBDOMAIN = process.env.SUBDOMAIN;
  const maxRetries = 3;

  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      const response = await axios.get(
        `https://${SUBDOMAIN}.kommo.com/api/v4/leads/${Number(leadId)}?with=contacts`,
        { headers: getKommoHeaders() },
      );
      return (
        response.data?._embedded?.contacts
          ?.map((c) => c.id)
          .filter(Boolean) ?? []
      );
    } catch (error) {
      if (error.response?.status === 429 && retry < maxRetries - 1) {
        await sleep(1000 * (retry + 1));
        continue;
      }
      console.warn(
        `[kommo] Falha ao buscar contatos do lead ${leadId}:`,
        error.response?.data ?? error.message,
      );
      return [];
    }
  }

  return [];
}

async function handleKommoUserRejected(
  selectedAttendant,
  groupSlug,
  skippedIds,
  remainingUsers,
) {
  console.warn(
    `[distribution/${groupSlug}] Kommo rejeitou user ${selectedAttendant._id}, removendo da fila.`,
  );
  const removalGroup = selectedAttendant._sourceGroup ?? groupSlug;
  await removeUserFromGroup(selectedAttendant._id, removalGroup);
  skippedIds.push(selectedAttendant._id);
  return remainingUsers.filter((u) => u._id !== selectedAttendant._id);
}

async function assignLeadInKommo(leadId, groupSlug, validUsers, useAtomicPointer) {
  let remainingUsers = [...validUsers];
  const skippedIds = [];
  const contactIds = await fetchLeadContactIds(leadId);

  if (!contactIds.length) {
    console.warn(
      `[distribution/${groupSlug}] Lead ${leadId} sem contatos vinculados; atribuindo apenas o lead.`,
    );
  }

  while (remainingUsers.length > 0) {
    let selectedAttendant;

    if (useAtomicPointer) {
      selectedAttendant = await getNextAttendant(groupSlug, remainingUsers);
    } else {
      if (indexPointers[groupSlug] == null) {
        indexPointers[groupSlug] = 0;
      }
      const indexDestination = indexPointers[groupSlug] % remainingUsers.length;
      selectedAttendant = remainingUsers[indexDestination];
      indexPointers[groupSlug] = (indexDestination + 1) % remainingUsers.length;
    }

    if (!selectedAttendant?._id) {
      return { success: false, error: "Atendente inválido na fila" };
    }

    try {
      await patchLeadInKommo(leadId, selectedAttendant._id);

      if (contactIds.length) {
        try {
          await patchContactsInKommo(contactIds, selectedAttendant._id);
        } catch (contactError) {
          if (isInvalidKommoUser(contactError)) {
            remainingUsers = await handleKommoUserRejected(
              selectedAttendant,
              groupSlug,
              skippedIds,
              remainingUsers,
            );
            continue;
          }

          const kommoError = contactError.response?.data;
          console.error(
            `[distribution/${groupSlug}] Erro ao atualizar contatos (user ${selectedAttendant._id}):`,
            JSON.stringify(kommoError ?? contactError.message, null, 2),
          );
          await writeDistributionLog({
            type: "kommo_error",
            group: groupSlug,
            leadId,
            message: summarizeKommoError(kommoError ?? contactError.message),
            details: {
              userId: selectedAttendant._id,
              contactIds,
              leadPatched: true,
              statusCode: contactError.response?.status,
              kommo: kommoError,
            },
          });
          return {
            success: false,
            error: kommoError
              ? JSON.stringify(kommoError)
              : contactError.message,
            assignedTo: selectedAttendant._id,
            statusCode: contactError.response?.status,
          };
        }
      }

      return { success: true, assignedTo: selectedAttendant._id };
    } catch (error) {
      if (isInvalidKommoUser(error)) {
        remainingUsers = await handleKommoUserRejected(
          selectedAttendant,
          groupSlug,
          skippedIds,
          remainingUsers,
        );
        continue;
      }

      const kommoError = error.response?.data;
      console.error(
        `[distribution/${groupSlug}] Erro da API do Kommo (user ${selectedAttendant._id}):`,
        JSON.stringify(kommoError ?? error.message, null, 2),
      );
      await writeDistributionLog({
        type: "kommo_error",
        group: groupSlug,
        leadId,
        message: summarizeKommoError(kommoError ?? error.message),
        details: {
          userId: selectedAttendant._id,
          statusCode: error.response?.status,
          kommo: kommoError,
        },
      });
      return {
        success: false,
        error: kommoError ? JSON.stringify(kommoError) : error.message,
        assignedTo: selectedAttendant._id,
        statusCode: error.response?.status,
      };
    }
  }

  const message = skippedIds.length
    ? `Nenhum atendente válido no Kommo. Removidos da fila: ${skippedIds.join(", ")}`
    : "Nenhum atendente válido no Kommo";

  await writeDistributionLog({
    type: "kommo_error",
    group: groupSlug,
    leadId,
    message,
    details: skippedIds.length ? { skippedIds } : undefined,
  });
  return { success: false, error: message };
}

async function acquireQueueLock(groupSlug) {
  const lockId = `${groupSlug}-processor`;
  const lockTtl = Number(process.env.ROTA_QUEUE_LOCK_TTL_MS ?? 300000);
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + lockTtl);

  await DistributionLock.findOneAndUpdate(
    { _id: lockId },
    { $setOnInsert: { lockedUntil: new Date(0) } },
    { upsert: true },
  );

  const acquired = await DistributionLock.findOneAndUpdate(
    { _id: lockId, lockedUntil: { $lte: now } },
    { $set: { lockedUntil } },
    { returnDocument: "after" },
  );

  return !!acquired;
}

async function releaseQueueLock(groupSlug) {
  await DistributionLock.findByIdAndUpdate(`${groupSlug}-processor`, {
    $set: { lockedUntil: new Date(0) },
  });
}

async function processGroupQueue(groupSlug) {
  const acquired = await acquireQueueLock(groupSlug);
  if (!acquired) return;

  const delayMs = Number(process.env.ROTA_DISTRIBUTION_DELAY_MS ?? 200);

  try {
    while (true) {
      const job = await DistributionJob.findOneAndUpdate(
        { group: groupSlug, status: "pending" },
        { $set: { status: "processing" } },
        { sort: { createdAt: 1 }, returnDocument: "after" },
      );

      if (!job) break;

      try {
        const validUsers = await getValidUsersForRoute(groupSlug);

        if (!validUsers.length) {
          const errorMsg = getNoUsersOnlineMessage(groupSlug);
          await DistributionJob.findByIdAndUpdate(job._id, {
            $set: { status: "failed", error: errorMsg },
          });
          await writeDistributionLog({
            type: "no_users_online",
            group: groupSlug,
            leadId: job.leadId,
            message: errorMsg,
          });
          continue;
        }

        const result = await assignLeadInKommo(
          job.leadId,
          groupSlug,
          validUsers,
          true,
        );

        await DistributionJob.findByIdAndUpdate(job._id, {
          $set: {
            status: result.success ? "done" : "failed",
            assignedTo: result.assignedTo,
            error: result.error,
          },
        });
      } catch (err) {
        await DistributionJob.findByIdAndUpdate(job._id, {
          $set: { status: "failed", error: err.message },
        });
        await writeDistributionLog({
          type: "queue_failed",
          group: groupSlug,
          leadId: job.leadId,
          message: err.message,
          details: { stack: err.stack },
        });
      }

      await sleep(delayMs);
    }
  } finally {
    await releaseQueueLock(groupSlug);
  }
}

async function enqueueGroupLead(leadId, groupSlug) {
  try {
    await DistributionJob.create({
      leadId: Number(leadId),
      group: groupSlug,
      status: "pending",
    });
    return { enqueued: true, duplicate: false };
  } catch (err) {
    if (err.code === 11000) {
      return { enqueued: true, duplicate: true };
    }
    throw err;
  }
}

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

app.use(async (req, res, next) => {
  try {
    await connectDB();
    await ensureSeeded();
    next();
  } catch (err) {
    console.error("[DB] Falha ao conectar:", err.message);
    return res.status(503).json({
      message: "Banco de dados indisponível",
      error: err.message,
    });
  }
});

async function handleDistribution(req, res, groupSlug) {
  const leadData = extractLeadFromBody(req.body);

  if (!leadData) {
    console.log("Webhook recebido, mas não está atrelado a um lead.");
    return res
      .status(200)
      .json({ message: "Ignorado: Não é uma atualização de lead." });
  }

  const leadId = leadData.id;
  const validUsers = await getOnlineValidUsers(groupSlug);

  if (!validUsers.length) {
    await writeDistributionLog({
      type: "no_users_online",
      group: groupSlug,
      leadId,
      message: `Nenhum usuário online no grupo ${groupSlug}`,
    });
    return res.status(200).json({
      message: `Ignorado: nenhum usuário online no grupo ${groupSlug}`,
    });
  }

  const result = await assignLeadInKommo(leadId, groupSlug, validUsers, false);

  if (result.success) {
    return res.status(200).json({
      message: "Lead e contato(s) atualizados com sucesso no Kommo",
    });
  }

  return res.status(result.statusCode || 500).json({
    message: "Erro ao atualizar lead e contato(s) no Kommo",
    error: result.error,
  });
}

async function handleQueueDistribution(req, res, groupSlug) {
  const leadData = extractLeadFromBody(req.body);

  if (!leadData) {
    console.log("Webhook recebido, mas não está atrelado a um lead.");
    return res
      .status(200)
      .json({ message: "Ignorado: Não é uma atualização de lead." });
  }

  try {
    const { duplicate } = await enqueueGroupLead(leadData.id, groupSlug);

    scheduleBackgroundWork(processGroupQueue(groupSlug));

    return res.status(200).json({
      message: duplicate
        ? "Lead já enfileirado para distribuição"
        : "Lead enfileirado para distribuição",
    });
  } catch (error) {
    console.error(`[distribution/${groupSlug}] Erro ao enfileirar:`, error);
    await writeDistributionLog({
      type: "enqueue_error",
      group: groupSlug,
      leadId: leadData.id,
      message: error.message,
    });
    return res.status(500).json({ message: error.message });
  }
}

async function handleRotaDistribution(req, res) {
  return handleQueueDistribution(req, res, ROTA_GROUP);
}

//Routes
app.get("/api/v1/health", async (req, res) => {
  const start = Date.now();

  try {
    await mongoose.connection.db.admin().ping();
    const latencyMs = Date.now() - start;

    return res.status(200).json({
      ok: true,
      status: "healthy",
      checks: {
        api: "up",
        database: "connected",
      },
      latencyMs,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[health] Falha no ping do banco:", error.message);

    return res.status(503).json({
      ok: false,
      status: "degraded",
      checks: {
        api: "up",
        database: "disconnected",
      },
      message: "Banco de dados indisponível",
      error: error.message,
      latencyMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    });
  }
});

app.post("/api/v1/presence", async (req, res) => {
  const { _id, name, status, group } = req.body;

  if (!group || !(await groupExists(group))) {
    return res.status(400).json({
      message: "Campo 'group' obrigatório e deve referenciar um grupo ativo.",
    });
  }

  if (!["online", "offline"].includes(status)) {
    return res.status(400).json({
      message: "Campo 'status' inválido. Use 'online' ou 'offline'.",
    });
  }

  try {
    const update =
      status === "online"
        ? {
          $addToSet: { groups: group },
          $set: { name, status: "online" },
        }
        : {
          $pull: { groups: group },
          $set: { name },
        };

    let usuarioAtualizado = await OnlineUser.findOneAndUpdate({ _id }, update, {
      upsert: status === "online",
      returnDocument: "after",
      runValidators: true,
    });

    if (status === "offline" && usuarioAtualizado) {
      const isStillOnline = usuarioAtualizado.groups.length > 0;
      if (!isStillOnline) {
        usuarioAtualizado = await OnlineUser.findOneAndUpdate(
          { _id },
          { status: "offline" },
          { returnDocument: "after", runValidators: true },
        );
      }
    }

    return res.status(200).json({
      message: "Status do usuário atualizado com sucesso!",
      data: usuarioAtualizado,
    });
  } catch (error) {
    console.error(error);
    await writeDistributionLog({
      type: "server_error",
      group,
      message: `Erro ao atualizar presença: ${error.message}`,
      details: { userId: _id },
    });
    return res.status(500).json({ message: error.message });
  }
});

app.get("/api/v1/status", async (req, res) => {
  try {
    const users = await OnlineUser.find({}, "_id name status groups").sort({
      createdAt: -1,
    });
    return res.status(200).json(users);
  } catch (error) {
    console.error("[ERRO NA ROTA GET]:", error);

    return res.status(500).json({
      message: "Erro interno no servidor ao buscar status",
      error: error.message,
    });
  }
});

app.get("/api/v1/groups", async (req, res) => {
  try {
    const groups = await PluginGroup.find({ active: true })
      .sort({ sortOrder: 1, label: 1 })
      .select("slug label distributionType sortOrder members");

    const compositeGroups = Object.values(COMPOSITE_ROUTES)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(formatCompositeGroupResponse);

    return res.status(200).json([
      ...groups.map(formatGroupResponse),
      ...compositeGroups,
    ]);
  } catch (error) {
    console.error("[groups GET]", error);
    return res.status(500).json({ message: error.message });
  }
});

app.post("/api/v1/groups", async (req, res) => {
  const { label, slug, distributionType, sortOrder } = req.body;

  if (!label?.trim()) {
    return res.status(400).json({ message: "Campo 'label' é obrigatório." });
  }

  const finalSlug = (slug?.trim() || slugifyLabel(label)).toLowerCase();

  if (!isValidSlug(finalSlug)) {
    return res.status(400).json({
      message: "Slug inválido. Use apenas letras minúsculas, números e hífens.",
    });
  }

  const distType =
    distributionType === "queue" ? "queue" : "instant";

  try {
    const existing = await PluginGroup.findOne({ slug: finalSlug });
    if (existing) {
      return res.status(409).json({ message: "Já existe um grupo com este slug." });
    }

    const maxOrder = await PluginGroup.findOne({ active: true })
      .sort({ sortOrder: -1 })
      .select("sortOrder");
    const order =
      sortOrder != null ? Number(sortOrder) : (maxOrder?.sortOrder ?? -1) + 1;

    const group = await PluginGroup.create({
      slug: finalSlug,
      label: label.trim(),
      distributionType: distType,
      sortOrder: order,
      members: [],
    });

    return res.status(201).json(formatGroupResponse(group));
  } catch (error) {
    console.error("[groups POST]", error);
    return res.status(500).json({ message: error.message });
  }
});

app.patch("/api/v1/groups/:slug", async (req, res) => {
  const { slug } = req.params;
  const { label, distributionType, sortOrder, active } = req.body;

  try {
    const group = await PluginGroup.findOne({ slug });
    if (!group) {
      return res.status(404).json({ message: "Grupo não encontrado." });
    }

    if (label != null) {
      if (!String(label).trim()) {
        return res.status(400).json({ message: "Label não pode ser vazio." });
      }
      group.label = String(label).trim();
    }

    if (distributionType != null) {
      if (!["instant", "queue"].includes(distributionType)) {
        return res.status(400).json({
          message: "distributionType deve ser 'instant' ou 'queue'.",
        });
      }
      group.distributionType = distributionType;
    }

    if (sortOrder != null) group.sortOrder = Number(sortOrder);
    if (active != null) group.active = Boolean(active);

    await group.save();
    return res.status(200).json(formatGroupResponse(group));
  } catch (error) {
    console.error("[groups PATCH]", error);
    return res.status(500).json({ message: error.message });
  }
});

app.delete("/api/v1/groups/:slug", async (req, res) => {
  const { slug } = req.params;

  try {
    const group = await PluginGroup.findOne({ slug });
    if (!group) {
      return res.status(404).json({ message: "Grupo não encontrado." });
    }

    const pendingJobs = await DistributionJob.countDocuments({
      group: slug,
      status: { $in: ["pending", "processing"] },
    });

    if (pendingJobs > 0) {
      return res.status(409).json({
        message: `Não é possível excluir: ${pendingJobs} job(s) pendente(s) ou em processamento.`,
      });
    }

    await OnlineUser.updateMany({}, { $pull: { groups: slug } });
    await PluginGroup.deleteOne({ slug });

    return res.status(200).json({ message: "Grupo removido com sucesso." });
  } catch (error) {
    console.error("[groups DELETE]", error);
    return res.status(500).json({ message: error.message });
  }
});

app.post("/api/v1/groups/:slug/members", async (req, res) => {
  const { slug } = req.params;
  const { userId, name } = req.body;

  if (!isValidKommoUserId(String(userId ?? ""))) {
    return res.status(400).json({
      message: "Campo 'userId' deve ser um ID numérico válido do Kommo.",
    });
  }

  if (!name?.trim()) {
    return res.status(400).json({ message: "Campo 'name' é obrigatório." });
  }

  try {
    const group = await PluginGroup.findOne({ slug, active: true });
    if (!group) {
      return res.status(404).json({ message: "Grupo não encontrado." });
    }

    const uid = String(userId);
    if (group.members.some((m) => m.userId === uid)) {
      return res.status(409).json({ message: "Usuário já pertence a este grupo." });
    }

    group.members.push({ userId: uid, name: name.trim() });
    await group.save();

    return res.status(201).json(formatGroupResponse(group));
  } catch (error) {
    console.error("[groups members POST]", error);
    return res.status(500).json({ message: error.message });
  }
});

app.delete("/api/v1/groups/:slug/members/:userId", async (req, res) => {
  const { slug, userId } = req.params;

  try {
    const group = await PluginGroup.findOne({ slug, active: true });
    if (!group) {
      return res.status(404).json({ message: "Grupo não encontrado." });
    }

    const before = group.members.length;
    group.members = group.members.filter((m) => m.userId !== String(userId));

    if (group.members.length === before) {
      return res.status(404).json({ message: "Membro não encontrado no grupo." });
    }

    await group.save();
    await removeUserFromGroup(userId, slug);

    return res.status(200).json(formatGroupResponse(group));
  } catch (error) {
    console.error("[groups members DELETE]", error);
    return res.status(500).json({ message: error.message });
  }
});

app.post("/api/v1/distribution/digital", (req, res) =>
  handleDistribution(req, res, "digital"),
);
app.post("/api/v1/distribution/vipzon", (req, res) =>
  handleDistribution(req, res, "vipzon"),
);
app.post("/api/v1/distribution/sac", (req, res) =>
  handleDistribution(req, res, "sac"),
);
app.post("/api/v1/distribution/pos-venda", (req, res) =>
  handleDistribution(req, res, "pos-venda"),
);
app.post("/api/v1/distribution/ef", (req, res) =>
  handleDistribution(req, res, "ef"),
);
app.post("/api/v1/distribution/rota", (req, res) =>
  handleRotaDistribution(req, res),
);
app.post("/api/v1/distribution/purificador", (req, res) =>
  handleQueueDistribution(req, res, "purificador"),
);
app.post("/api/v1/distribution/digital-purificador", (req, res) =>
  handleQueueDistribution(req, res, "digital-purificador"),
);
app.post("/api/v1/distribution/digital-ef", (req, res) =>
  handleQueueDistribution(req, res, "digital-ef"),
);
app.post("/api/v1/distribution/purificador-ef", (req, res) =>
  handleQueueDistribution(req, res, "purificador-ef"),
);

app.post("/api/v1/distribution/:groupSlug", async (req, res) => {
  const { groupSlug } = req.params;

  try {
    const composite = getCompositeRoute(groupSlug);
    if (composite?.distributionType === "queue") {
      return handleQueueDistribution(req, res, groupSlug);
    }

    const group = await getActiveGroup(groupSlug);
    if (!group) {
      return res.status(404).json({ message: "Grupo não encontrado." });
    }

    if (group.distributionType === "queue") {
      return handleQueueDistribution(req, res, groupSlug);
    }

    return handleDistribution(req, res, groupSlug);
  } catch (error) {
    console.error(`[distribution/${groupSlug}]`, error);
    return res.status(500).json({ message: error.message });
  }
});

async function handleQueueStatus(req, res, groupSlug) {
  try {
    const composite = getCompositeRoute(groupSlug);
    const group = composite ?? (await getActiveGroup(groupSlug));
    if (!group) {
      return res.status(404).json({ message: "Grupo não encontrado." });
    }
    if (group.distributionType !== "queue") {
      return res.status(404).json({ message: "Grupo não utiliza fila." });
    }

    const statuses = ["pending", "processing", "done", "failed"];
    const counts = Object.fromEntries(
      await Promise.all(
        statuses.map(async (status) => [
          status,
          await DistributionJob.countDocuments({ group: groupSlug, status }),
        ]),
      ),
    );

    const response = { ...counts };

    if (req.query.include === "failed") {
      response.failedJobs = await DistributionJob.find({
        group: groupSlug,
        status: "failed",
      })
        .sort({ createdAt: -1 })
        .limit(20)
        .select("leadId error assignedTo createdAt");
    }

    return res.status(200).json(response);
  } catch (error) {
    console.error(`[distribution/${groupSlug}/queue]`, error);
    return res.status(500).json({ message: error.message });
  }
}

app.get("/api/v1/distribution/rota/queue", (req, res) =>
  handleQueueStatus(req, res, ROTA_GROUP),
);

app.get("/api/v1/distribution/:groupSlug/queue", (req, res) =>
  handleQueueStatus(req, res, req.params.groupSlug),
);

app.get("/api/v1/logs", async (req, res) => {
  try {
    const group = req.query.group;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const filter = group ? { group } : {};

    const logs = await DistributionLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("type group leadId message details createdAt");

    return res.status(200).json(logs);
  } catch (error) {
    console.error("[logs]", error);
    return res.status(500).json({ message: error.message });
  }
});

export default app;

if (process.env.NODE_ENV !== "production") {
  const port = process.env.PORT ?? 3000;
  app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
  });
}
