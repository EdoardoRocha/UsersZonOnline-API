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

const VALID_GROUPS = ["digital", "vipzon", "sac", "pos-venda", "ef", "rota"];
const ROTA_GROUP = "rota";

const indexPointers = {
  digital: 0,
  vipzon: 0,
  sac: 0,
  "pos-venda": 0,
  ef: 0,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractLeadFromBody(body) {
  return body.leads?.add?.[0] || body.leads?.status?.[0];
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
        enum: VALID_GROUPS,
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

async function getOnlineValidUsers(groupSlug) {
  const onlineUsers = await OnlineUser.find({
    groups: groupSlug,
    status: "online",
  }).sort({ createdAt: -1 });

  return onlineUsers.filter(
    (u) => u._id && Number.isInteger(Number(u._id)) && Number(u._id) > 0,
  );
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

async function patchLeadInKommo(leadId, responsibleUserId) {
  const SUBDOMAIN = process.env.SUBDOMAIN;
  const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
  const maxRetries = 3;

  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      await axios.patch(
        `https://${SUBDOMAIN}.kommo.com/api/v4/leads`,
        [
          {
            id: Number(leadId),
            responsible_user_id: Number(responsibleUserId),
          },
        ],
        {
          headers: {
            Authorization: `Bearer ${ACCESS_TOKEN}`,
            "Content-Type": "application/json",
          },
        },
      );
      return { success: true };
    } catch (error) {
      if (error.response?.status === 429 && retry < maxRetries - 1) {
        await sleep(1000 * (retry + 1));
        continue;
      }
      throw error;
    }
  }
}

async function assignLeadInKommo(leadId, groupSlug, validUsers, useAtomicPointer) {
  for (let attempt = 0; attempt < validUsers.length; attempt++) {
    let selectedAttendant;

    if (useAtomicPointer) {
      selectedAttendant = await getNextAttendant(groupSlug, validUsers);
    } else {
      if (indexPointers[groupSlug] == null) {
        indexPointers[groupSlug] = 0;
      }
      const indexDestination = indexPointers[groupSlug] % validUsers.length;
      selectedAttendant = validUsers[indexDestination];
      indexPointers[groupSlug] = (indexDestination + 1) % validUsers.length;
    }

    if (!selectedAttendant?._id) {
      return { success: false, error: "Atendente inválido na fila" };
    }

    try {
      await patchLeadInKommo(leadId, selectedAttendant._id);
      return { success: true, assignedTo: selectedAttendant._id };
    } catch (error) {
      if (isInvalidKommoUser(error) && attempt < validUsers.length - 1) {
        console.warn(
          `[distribution/${groupSlug}] Kommo rejeitou user ${selectedAttendant._id}, tentando próximo.`,
        );
        continue;
      }

      const kommoError = error.response?.data;
      console.error(
        `[distribution/${groupSlug}] Erro da API do Kommo (user ${selectedAttendant._id}):`,
        JSON.stringify(kommoError ?? error.message, null, 2),
      );
      return {
        success: false,
        error: kommoError ? JSON.stringify(kommoError) : error.message,
        assignedTo: selectedAttendant._id,
        statusCode: error.response?.status,
      };
    }
  }

  return { success: false, error: "Nenhum atendente válido no Kommo" };
}

async function acquireRotaLock() {
  const lockTtl = Number(process.env.ROTA_QUEUE_LOCK_TTL_MS ?? 300000);
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + lockTtl);

  await DistributionLock.findOneAndUpdate(
    { _id: "rota-processor" },
    { $setOnInsert: { lockedUntil: new Date(0) } },
    { upsert: true },
  );

  const acquired = await DistributionLock.findOneAndUpdate(
    { _id: "rota-processor", lockedUntil: { $lte: now } },
    { $set: { lockedUntil } },
    { returnDocument: "after" },
  );

  return !!acquired;
}

async function releaseRotaLock() {
  await DistributionLock.findByIdAndUpdate("rota-processor", {
    $set: { lockedUntil: new Date(0) },
  });
}

async function processRotaQueue() {
  const acquired = await acquireRotaLock();
  if (!acquired) return;

  const delayMs = Number(process.env.ROTA_DISTRIBUTION_DELAY_MS ?? 200);

  try {
    while (true) {
      const job = await DistributionJob.findOneAndUpdate(
        { group: ROTA_GROUP, status: "pending" },
        { $set: { status: "processing" } },
        { sort: { createdAt: 1 }, returnDocument: "after" },
      );

      if (!job) break;

      try {
        const validUsers = await getOnlineValidUsers(ROTA_GROUP);

        if (!validUsers.length) {
          await DistributionJob.findByIdAndUpdate(job._id, {
            $set: {
              status: "failed",
              error: "Nenhum usuário online no grupo rota",
            },
          });
          continue;
        }

        const result = await assignLeadInKommo(
          job.leadId,
          ROTA_GROUP,
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
      }

      await sleep(delayMs);
    }
  } finally {
    await releaseRotaLock();
  }
}

async function enqueueRotaLead(leadId) {
  try {
    await DistributionJob.create({
      leadId: Number(leadId),
      group: ROTA_GROUP,
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
    return res.status(400).json({
      message: `Nenhum usuário online no grupo ${groupSlug} nesse momento.`,
    });
  }

  const result = await assignLeadInKommo(leadId, groupSlug, validUsers, false);

  if (result.success) {
    return res
      .status(200)
      .json({ message: "Lead atualizado com sucesso no kommo" });
  }

  return res.status(result.statusCode || 500).json({
    message: "Erro ao atualizar lead no Kommo",
    error: result.error,
  });
}

async function handleRotaDistribution(req, res) {
  const leadData = extractLeadFromBody(req.body);

  if (!leadData) {
    console.log("Webhook recebido, mas não está atrelado a um lead.");
    return res
      .status(200)
      .json({ message: "Ignorado: Não é uma atualização de lead." });
  }

  try {
    const { duplicate } = await enqueueRotaLead(leadData.id);

    scheduleBackgroundWork(processRotaQueue());

    return res.status(200).json({
      message: duplicate
        ? "Lead já enfileirado para distribuição"
        : "Lead enfileirado para distribuição",
    });
  } catch (error) {
    console.error("[distribution/rota] Erro ao enfileirar:", error);
    return res.status(500).json({ message: error.message });
  }
}

//Routes
app.get("/api/v1/health", async (req, res) => {
  return res.status(200).json({
    ok: true,
    db: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

app.post("/api/v1/presence", async (req, res) => {
  const { _id, name, status, group } = req.body;

  if (!group || !VALID_GROUPS.includes(group)) {
    return res.status(400).json({
      message: `Campo 'group' obrigatório. Valores válidos: ${VALID_GROUPS.join(", ")}`,
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

app.get("/api/v1/distribution/rota/queue", async (req, res) => {
  try {
    const statuses = ["pending", "processing", "done", "failed"];
    const counts = Object.fromEntries(
      await Promise.all(
        statuses.map(async (status) => [
          status,
          await DistributionJob.countDocuments({ group: ROTA_GROUP, status }),
        ]),
      ),
    );

    return res.status(200).json(counts);
  } catch (error) {
    console.error("[distribution/rota/queue]", error);
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
