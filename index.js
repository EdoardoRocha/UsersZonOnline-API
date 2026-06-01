import "dotenv/config";
import cors from "cors";
import express from "express";
import mongoose, { Schema } from "mongoose";
import { EventEmitter } from "events";
import axios from "axios";
import { connectDB } from "./db.js";

const app = express();
EventEmitter.defaultMaxListeners = 20;

const VALID_GROUPS = ["digital", "vipzon", "sac", "pos-venda", "ef", "rota"];

const indexPointers = {
  digital: 0,
  vipzon: 0,
  sac: 0,
  "pos-venda": 0,
  ef: 0,
};

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
  const leadData = req.body.leads?.add?.[0] || req.body.leads?.status?.[0];;

  if (!leadData) {
    console.log("Webhook recebido, mas não está atrelado a um lead.");
    return res
      .status(200)
      .json({ message: "Ignorado: Não é uma atualização de lead." });
  }

  const leadId = leadData.id;

  const onlineUsers = await OnlineUser.find({ groups: groupSlug });

  if (!onlineUsers.length) {
    return res.status(400).json({
      message: `Nenhum usuário online no grupo ${groupSlug} nesse momento.`,
    });
  }

  const indexDestination = indexPointers[groupSlug] % onlineUsers.length;
  const selectedAttendant = onlineUsers[indexDestination];
  indexPointers[groupSlug] = (indexDestination + 1) % onlineUsers.length;

  const SUBDOMAIN = process.env.SUBDOMAIN;
  const ACCESS_TOKEN = process.env.ACCESS_TOKEN;

  try {
    await axios.patch(
      `https://${SUBDOMAIN}.kommo.com/api/v4/leads`,
      [
        {
          id: Number(leadId),
          responsible_user_id: Number(selectedAttendant._id),
        },
      ],
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      },
    );
    return res
      .status(200)
      .json({ message: "Lead atualizado com sucesso no kommo" });
  } catch (error) {
    if (error.response) {
      console.error(
        "Erro da API do Kommo:",
        JSON.stringify(error.response.data, null, 2),
      );
      return res.status(error.response.status || 500).json({
        message: "Erro ao atualizar lead no Kommo",
        error: error.response.data,
      });
    }
    console.error("Erro na distribuição: " + error);
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
    const users = await OnlineUser.find({}, "_id name status groups");
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
  handleDistribution(req, res, "rota"),
);

export default app;

if (process.env.NODE_ENV !== "production") {
  const port = process.env.PORT ?? 3000;
  app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
  });
}
