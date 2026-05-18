import "dotenv/config";
import cors from "cors";
import express from "express";
import mongoose, { Schema } from "mongoose";
import { EventEmitter } from "events";
import { type } from "os";

const app = express();
EventEmitter.defaultMaxListeners = 20;

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
      onlineUsers: {
        type: Array,
      },
    },
    { timestamps: true },
  ),
);

// Middlewares
app.use(express.json());
app.use(cors());

let usersOnline = [];

app.post("/api/v1/presence", async (req, res) => {
  usersOnline = req.body.online_users;

  console.log(`[DEBUG] Passou aqui.`);

  try {
    const documentExists = await OnlineUser.findOne();

    if (documentExists) {
      await OnlineUser.findOneAndUpdate(
        {},
        { onlineUsers: usersOnline },
        { new: true, runValidators: true },
      );

      return res
        .status(200)
        .json({ message: "Documento de usuários atualizado!" });
    } else {
      await OnlineUser.create({ onlineUsers: usersOnline });
      return res.status(201).json({ message: "Documento de usuários criado!" });
    }
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: error.message });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`Servidor rodando na porta ${process.env.PORT}`);
});
