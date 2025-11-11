const express = require("express");
const app = express();
const port = 3000;

app.use(express.json());

const { pool, ping } = require("./connection"); // ← importa tu conexión

// RUTA DE PRUEBA
app.get("/", (req, res) => {
  res.send("Hello World!");
});

// RUTAS DE USUARIOS
app.get("/usuarios", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM users");
    res.json(rows);
  } catch (err) {
    console.error("Error al obtener usuarios:", err);
    res.status(500).send("Error en el servidor");
  }
});

app.post("/usuarios", async (req, res) => {
  const { nombre, email, telefono, edad } = req.body;

  if (!nombre || !email) {
    return res
      .status(400)
      .json({ error: "Los campos nombre y email son obligatorios" });
  }

  try {
    const query =
      "INSERT INTO users (nombre, email, telefono, edad) VALUES (?, ?, ?, ?)";
    const [result] = await pool.query(query, [
      nombre,
      email,
      telefono || null,
      edad || null,
    ]);

    res.status(201).json({
      message: "Usuario creado exitosamente",
      id: result.insertId,
      usuario: { id: result.insertId, nombre, email, telefono, edad },
    });
  } catch (err) {
    console.error("Error al crear usuario:", err);

    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "El email ya está registrado" });
    }

    res.status(500).json({ error: "Error interno del servidor" });
  }
});

function validatePostBody(body) {
  if (!body || typeof body !== "object") return "Body inválido";
  const { user_id, status, details } = body;
  if (!user_id || !status) return "user_id y status son obligatorios";
  if (!Array.isArray(details) || details.length === 0)
    return "Debe haber al menos 1 detalle";
  if (details.length > 5)
    return "No se pueden guardar más de 5 productos por compra";
  for (const d of details) {
    if (!d.product_id || !d.quantity || !("price" in d))
      return "Cada detalle requiere product_id, quantity y price";
    if (d.quantity <= 0) return "Las cantidades deben ser > 0";
    if (Number(d.price) < 0) return "El precio no puede ser negativo";
  }
  return null;
}

async function buildPurchasesFromRows(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.id)) {
      map.set(r.id, {
        id: r.id,
        user: r.user_name,
        total: Number(r.total),
        status: r.status,
        purchase_date: r.purchase_date,
        details: [],
      });
    }
    if (r.detail_id) {
      map.get(r.id).details.push({
        id: r.detail_id,
        product: r.product_name,
        quantity: r.quantity,
        price: Number(r.price),
        subtotal: Number(r.subtotal),
      });
    }
  }
  return Array.from(map.values());
}

// Aquí viene el nuevo bloque con verificación de base de datos
app.listen(port, async () => {
  const dbOk = await ping();
  if (dbOk) {
    console.log(` Server listening at http://localhost:${port}`);
  } else {
    console.log(
      " El servidor está corriendo, pero la base de datos no respondió."
    );
  }
});
