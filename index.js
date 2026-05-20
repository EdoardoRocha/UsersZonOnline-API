import "dotenv/config";
import cors from "cors";
import express from "express";
import mongoose, { Schema } from "mongoose";
import { EventEmitter } from "events";
import { type } from "os";
import axios from "axios";

const app = express();
EventEmitter.defaultMaxListeners = 20;

// Global Variables
let indexCurrentPointer = 0;

// Conexão
async function main() {
  await mongoose.connect(process.env.MONGO_URL);
  console.log("Conectou ao mongoose");
}
main().catch((err) => console.log(err));

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
    },
    { timestamps: true },
  ),
);

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

//Routes
app.post("/api/v1/presence", async (req, res) => {
  const { _id, name, status } = req.body;

  try {
    const usuarioAtualizado = await OnlineUser.findOneAndUpdate(
      { _id },
      { name, status },
      {
        upsert: true,
        returnDocument: "after",
        runValidators: true,
      },
    );

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
    const users = await OnlineUser.find({}, "_id name status");
    return res.status(200).json(users);
  } catch (error) {
    console.error("[ERRO NA ROTA GET]:", error);

    return res.status(500).json({
      message: "Erro interno no servidor ao buscar status",
      error: error.message,
    });
  }
});

app.post("/api/v1/distribution", async (req, res) => {
  const leadData = req.body.leads?.status?.[0];

  if (!leadData) {
    console.log("Webhook recebido, mas não está atrelado a um lead.");
    return res
      .status(200)
      .json({ message: "Ignorado: Não é uma atualização de lead." });
  }

  const leadId = leadData.id;

  // Puxar lista dos usuários online
  const onlineUsers = await OnlineUser.find({ status: "online" }, null, {
    sort: { createdAt: -1 },
  });
  // Verificar se todos estão offline
  if (!onlineUsers)
    return res
      .status(400)
      .json({ message: "Nenhum usuário online nesse momento." });
  // Construir lógico de fila
  let indexDestination = indexCurrentPointer % onlineUsers.length;
  const selectedAttendant = onlineUsers[indexDestination];
  indexCurrentPointer = (indexDestination + 1) % onlineUsers.length;

  const SUBDOMAIN = process.env.SUBDOMAIN;
  const ACCESS_TOKEN = process.env.ACCESS_TOKEN;

  //Enviar resposta para o Kommo
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
      return;
    }
    console.error("Erro na distribuição: " + error);
    return res.status(500).json({ message: error.message });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`Servidor rodando na porta ${process.env.PORT}`);
});
