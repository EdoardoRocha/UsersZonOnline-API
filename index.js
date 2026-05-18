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
      },
    },
    { timestamps: true },
  ),
);

// Middlewares
app.use(express.json());
app.use(cors());

//Routes
app.post("/api/v1/presence", async (req, res) => {
  const { _id, name, status } = req.body;

  try {
    const usuarioAtualizado = await OnlineUser.findOneAndUpdate(
      { _id }, // 1º: Filtro (busca pelo ID fixo do vendedor)
      { name, status }, // 2º: Dados para atualizar (juntos no mesmo objeto)
      {
        upsert: true, // Se não existir, cria um novo documento
        new: true, // Retorna o documento modificado
        runValidators: true, // Garante as validações do seu Schema
      },
    );

    return res
      .status(200)
      .json({
        message: "Status do usuário atualizado com sucesso!",
        data: usuarioAtualizado,
      });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: error.message });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`Servidor rodando na porta ${process.env.PORT}`);
});
