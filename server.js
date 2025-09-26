const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'skillvault',
  password: 'yourpassword',
  port: 5432,
});

// Basic route to serve your HTML file
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/skill-vault-website.html');
});

// Start server
app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});

// Add these routes before app.listen()

// User registration
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  
  try {
    // In production, you should hash the password first!
    const result = await pool.query(
      'INSERT INTO users(username, email, password_hash) VALUES($1, $2, $3) RETURNING *',
      [username, email, password]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// User login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND password_hash = $2',
      [email, password]
    );
    
    if (result.rows.length > 0) {
      res.json({ success: true, user: result.rows[0] });
    } else {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/login', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, email, password, user_type 
       FROM users 
       WHERE email = ?`,
      [req.body.email]
    );
    
    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }
    
    const user = rows[0];
    const validPassword = await bcrypt.compare(req.body.password, user.password);
    
    if (!validPassword) {
      return res.status(401).json({ success: false, message: 'Invalid password' });
    }
    
    // MySQL-specific query for additional user data if needed
    const [userData] = await pool.execute(
      `SELECT * FROM user_profiles WHERE user_id = ?`,
      [user.id]
    );
    
    // ... rest of login logic ...
  } catch (err) {
    console.error('MySQL Error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});
