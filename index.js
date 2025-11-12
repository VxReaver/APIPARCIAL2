const express = require("express");
const app = express();
const port = 3000;

app.use(express.json());

const { pool, ping } = require("./connection"); // ✅ conexión MySQL

// ========================================================
// RUTA DE PRUEBA
// ========================================================
app.get("/", (req, res) => {
  res.send("✅ API funcionando correctamente!");
});

// ========================================================
// RUTAS DE USUARIOS
// ========================================================
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

// ========================================================
// CRUD DE PRODUCTS
// ========================================================

// ✅ Obtener todos los productos
app.get("/api/products", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM products ORDER BY id ASC");
    res.json(rows);
  } catch (err) {
    console.error("Error al obtener productos:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ✅ Obtener un producto por ID
app.get("/api/products/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "ID inválido" });

  try {
    const [rows] = await pool.query("SELECT * FROM products WHERE id = ?", [
      id,
    ]);
    if (rows.length === 0)
      return res.status(404).json({ error: "Producto no encontrado" });
    res.json(rows[0]);
  } catch (err) {
    console.error("Error al obtener producto:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ✅ Crear un nuevo producto
app.post("/api/products", async (req, res) => {
  const { name, description, price, stock } = req.body;

  if (!name || price == null || stock == null) {
    return res
      .status(400)
      .json({ error: "Los campos name, price y stock son obligatorios" });
  }

  try {
    const query =
      "INSERT INTO products (name, description, price, stock) VALUES (?, ?, ?, ?)";
    const [result] = await pool.query(query, [
      name,
      description || null,
      Number(price),
      Number(stock),
    ]);

    res.status(201).json({
      message: "Producto creado exitosamente",
      id: result.insertId,
      producto: { id: result.insertId, name, description, price, stock },
    });
  } catch (err) {
    console.error("Error al crear producto:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ✅ Actualizar un producto
app.put("/api/products/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { name, description, price, stock } = req.body;
  if (!id) return res.status(400).json({ error: "ID inválido" });

  try {
    const [rows] = await pool.query("SELECT * FROM products WHERE id = ?", [
      id,
    ]);
    if (rows.length === 0)
      return res.status(404).json({ error: "Producto no encontrado" });

    const updatedProduct = {
      name: name ?? rows[0].name,
      description: description ?? rows[0].description,
      price: price ?? rows[0].price,
      stock: stock ?? rows[0].stock,
    };

    await pool.query(
      "UPDATE products SET name = ?, description = ?, price = ?, stock = ? WHERE id = ?",
      [
        updatedProduct.name,
        updatedProduct.description,
        updatedProduct.price,
        updatedProduct.stock,
        id,
      ]
    );

    res.json({ message: "Producto actualizado", producto: updatedProduct });
  } catch (err) {
    console.error("Error al actualizar producto:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ✅ Eliminar un producto
app.delete("/api/products/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "ID inválido" });

  try {
    const [rows] = await pool.query("SELECT * FROM products WHERE id = ?", [
      id,
    ]);
    if (rows.length === 0)
      return res.status(404).json({ error: "Producto no encontrado" });

    await pool.query("DELETE FROM products WHERE id = ?", [id]);
    res.json({ message: "Producto eliminado", id });
  } catch (err) {
    console.error("Error al eliminar producto:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ========================================================
// RUTAS DE PURCHASES
// ========================================================
function validatePostBody(body) {
  if (!body || typeof body !== "object") return "Body inválido";
  const { user_id, status, details } = body;
  if (!user_id || !status) return "user_id y status son obligatorios";
  if (!Array.isArray(details) || details.length === 0)
    return "Debe haber al menos 1 detalle";
  for (const d of details) {
    if (!d.product_id || !d.quantity || !("price" in d))
      return "Cada detalle requiere product_id, quantity y price";
    if (d.quantity <= 0) return "Las cantidades deben ser > 0";
    if (Number(d.price) < 0) return "El precio no puede ser negativo";
  }
  return null;
}

// ✅ Crear una compra
app.post("/api/purchases", async (req, res) => {
  const err = validatePostBody(req.body);
  if (err) return res.status(400).json({ message: err });

  const { user_id, status, details } = req.body;
  const total = details.reduce(
    (acc, d) => acc + Number(d.price) * Number(d.quantity),
    0
  );

  if (total > 3500)
    return res.status(400).json({ message: "El total no puede superar $3500" });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Verificar stock
    for (const d of details) {
      const [p] = await conn.query(
        "SELECT id, stock FROM products WHERE id = ? FOR UPDATE",
        [d.product_id]
      );

      if (p.length === 0) throw new Error(`Producto ${d.product_id} no existe`);
      if (p[0].stock < d.quantity)
        throw new Error(`Stock insuficiente para producto ${d.product_id}`);
    }

    const [ins] = await conn.query(
      "INSERT INTO purchases (user_id, total, status, purchase_date) VALUES (?, ?, ?, NOW())",
      [user_id, total, status]
    );
    const purchaseId = ins.insertId;

    for (const d of details) {
      const subtotal = Number(d.price) * Number(d.quantity);
      await conn.query(
        "INSERT INTO purchase_details (purchase_id, product_id, quantity, price, subtotal) VALUES (?, ?, ?, ?, ?)",
        [purchaseId, d.product_id, d.quantity, d.price, subtotal]
      );
      await conn.query("UPDATE products SET stock = stock - ? WHERE id = ?", [
        d.quantity,
        d.product_id,
      ]);
    }

    await conn.commit();
    res.status(201).json({ id: purchaseId, message: "Compra creada" });
  } catch (e) {
    await conn.rollback();
    res.status(400).json({ message: e.message });
  } finally {
    conn.release();
  }
});

// ========================================================
// MIDDLEWARE DE ERRORES
// ========================================================
app.use((err, _req, res, _next) => {
  console.error("Unhandled Error:", err);
  res.status(500).json({ error: "Error interno del servidor" });
});

// ========================================================
// SERVIDOR + VERIFICACIÓN DE BASE DE DATOS
// ========================================================
app.listen(port, async () => {
  const dbOk = await ping();
  if (dbOk) {
    console.log(`✅ Server listening at http://localhost:${port}`);
  } else {
    console.log(
      "⚠️ El servidor está corriendo, pero la base de datos no respondió."
    );
  }
});
