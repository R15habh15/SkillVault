// vcreds-api.js - Backend API for VCreds Purchase and Selling
const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./db'); // Your existing database connection

const router = express.Router();

// Initialize Razorpay with test credentials
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_RM63ZT0AQ0JWv7',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'fB3zeaS0xwRHkkMcT5k5V0sG'
});

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret', (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
};

// GET: Get user's VCreds balance
router.get('/balance', authenticateToken, async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT vcreds_balance FROM users WHERE id = ?',
            [req.user.id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({ 
            balance: rows[0].vcreds_balance || 0,
            user_id: req.user.id 
        });
    } catch (error) {
        console.error('Error fetching balance:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST: Create Razorpay order for VCreds purchase
router.post('/purchase/create-order', authenticateToken, async (req, res) => {
    try {
        const { plan, credits, amount } = req.body;

        if (!plan || !credits || !amount) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Validate plan amounts
        const validPlans = {
            'starter': { credits: 500, amount: 500 },
            'professional': { credits: 1000, amount: 950 },
            'business': { credits: 2500, amount: 2250 },
            'enterprise': { credits: 5000, amount: 4250 }
        };

        if (!validPlans[plan] || validPlans[plan].amount !== amount) {
            return res.status(400).json({ error: 'Invalid plan or amount' });
        }

        // Create Razorpay order
        const options = {
            amount: amount * 100, // Amount in paise
            currency: 'INR',
            receipt: `vcreds_${req.user.id}_${Date.now()}`,
            notes: {
                user_id: req.user.id,
                plan: plan,
                credits: credits,
                type: 'purchase'
            }
        };

        const order = await razorpay.orders.create(options);

        // Save order details in database
        await pool.execute(`
            INSERT INTO vcreds_transactions 
            (user_id, type, razorpay_order_id, amount, credits, status, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, NOW())
        `, [req.user.id, 'purchase', order.id, amount, credits, 'pending']);

        res.json({
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            key: process.env.RAZORPAY_KEY_ID || 'rzp_test_RM63ZT0AQ0JWv7'
        });

    } catch (error) {
        console.error('Error creating order:', error);
        res.status(500).json({ error: 'Failed to create order' });
    }
});

// POST: Verify payment and add credits
router.post('/purchase/verify', authenticateToken, async (req, res) => {
    try {
        const {
            razorpay_payment_id,
            razorpay_order_id,
            razorpay_signature
        } = req.body;

        // Verify signature
        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'fB3zeaS0xwRHkkMcT5k5V0sG')
            .update(body.toString())
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ error: 'Invalid payment signature' });
        }

        // Get transaction details
        const [transaction] = await pool.execute(
            'SELECT * FROM vcreds_transactions WHERE razorpay_order_id = ? AND user_id = ?',
            [razorpay_order_id, req.user.id]
        );

        if (transaction.length === 0) {
            return res.status(404).json({ error: 'Transaction not found' });
        }

        const txn = transaction[0];

        // Update transaction status and payment ID
        await pool.execute(`
            UPDATE vcreds_transactions 
            SET status = 'completed', razorpay_payment_id = ?, completed_at = NOW()
            WHERE id = ?
        `, [razorpay_payment_id, txn.id]);

        // Add credits to user account
        await pool.execute(`
            UPDATE users 
            SET vcreds_balance = vcreds_balance + ?
            WHERE id = ?
        `, [txn.credits, req.user.id]);

        // Log credit addition
        await pool.execute(`
            INSERT INTO vcreds_log 
            (user_id, type, amount, balance_after, description, created_at) 
            VALUES (?, ?, ?, (SELECT vcreds_balance FROM users WHERE id = ?), ?, NOW())
        `, [req.user.id, 'credit', txn.credits, req.user.id, `Purchased ${txn.credits} VCreds`]);

        res.json({ 
            success: true, 
            credits_added: txn.credits,
            message: 'Payment verified and credits added successfully'
        });

    } catch (error) {
        console.error('Error verifying payment:', error);
        res.status(500).json({ error: 'Payment verification failed' });
    }
});

// POST: Create sell request
router.post('/sell/create-request', authenticateToken, async (req, res) => {
    try {
        const { amount, bank_details } = req.body;

        if (!amount || amount < 100) {
            return res.status(400).json({ error: 'Minimum sell amount is 100 VCreds' });
        }

        if (!bank_details || !bank_details.account_number || !bank_details.ifsc_code) {
            return res.status(400).json({ error: 'Valid bank details required' });
        }

        // Check user balance
        const [balanceResult] = await pool.execute(
            'SELECT vcreds_balance FROM users WHERE id = ?',
            [req.user.id]
        );

        if (balanceResult.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const currentBalance = balanceResult[0].vcreds_balance || 0;
        if (currentBalance < amount) {
            return res.status(400).json({ error: 'Insufficient VCreds balance' });
        }

        // Calculate amounts
        const conversionRate = 0.95; // 95% conversion rate
        const processingFeeRate = 0.025; // 2.5% processing fee
        const grossAmount = amount * conversionRate;
        const processingFee = grossAmount * processingFeeRate;
        const netAmount = grossAmount - processingFee;

        // Deduct credits from user account immediately
        await pool.execute(
            'UPDATE users SET vcreds_balance = vcreds_balance - ? WHERE id = ?',
            [amount, req.user.id]
        );

        // Create sell transaction
        const sellRequest = await pool.execute(`
            INSERT INTO vcreds_transactions 
            (user_id, type, amount, credits, net_amount, processing_fee, bank_details, status, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `, [
            req.user.id,
            'sell',
            grossAmount,
            amount,
            netAmount,
            processingFee,
            JSON.stringify(bank_details),
            'pending'
        ]);

        // Log credit deduction
        await pool.execute(`
            INSERT INTO vcreds_log 
            (user_id, type, amount, balance_after, description, created_at) 
            VALUES (?, ?, ?, (SELECT vcreds_balance FROM users WHERE id = ?), ?, NOW())
        `, [req.user.id, 'debit', amount, req.user.id, `Sold ${amount} VCreds`]);

        // In production, trigger bank transfer via Razorpay Payouts API
        // For now, we'll simulate the process

        res.json({
            success: true,
            transaction_id: sellRequest[0].insertId,
            credits_sold: amount,
            net_amount: netAmount.toFixed(2),
            processing_fee: processingFee.toFixed(2),
            estimated_processing_time: '3-5 business days',
            message: 'Sell request created successfully'
        });

    } catch (error) {
        console.error('Error creating sell request:', error);
        res.status(500).json({ error: 'Failed to create sell request' });
    }
});

// POST: Process sell request (Admin endpoint - would be called by a cron job or admin panel)
router.post('/sell/process/:transactionId', authenticateToken, async (req, res) => {
    try {
        // This endpoint would typically be protected with admin authentication
        // For demo purposes, we'll allow any authenticated user
        
        const { transactionId } = req.params;

        // Get transaction details
        const [transaction] = await pool.execute(
            'SELECT * FROM vcreds_transactions WHERE id = ? AND type = "sell" AND status = "pending"',
            [transactionId]
        );

        if (transaction.length === 0) {
            return res.status(404).json({ error: 'Transaction not found or already processed' });
        }

        const txn = transaction[0];
        const bankDetails = JSON.parse(txn.bank_details);

        // In production, initiate bank transfer using Razorpay Payouts API
        /*
        const payoutData = {
            account_number: bankDetails.account_number,
            fund_account: {
                account_type: 'bank_account',
                bank_account: {
                    name: bankDetails.account_holder,
                    ifsc: bankDetails.ifsc_code,
                    account_number: bankDetails.account_number
                }
            },
            amount: txn.net_amount * 100, // Amount in paise
            currency: 'INR',
            mode: 'NEFT',
            purpose: 'payout',
            notes: {
                transaction_id: txn.id,
                user_id: txn.user_id
            }
        };

        const payout = await razorpay.payouts.create(payoutData);
        */

        // For demo, simulate successful payout
        const simulatedPayoutId = `pout_${Date.now()}`;

        // Update transaction status
        await pool.execute(`
            UPDATE vcreds_transactions 
            SET status = 'completed', razorpay_payout_id = ?, completed_at = NOW()
            WHERE id = ?
        `, [simulatedPayoutId, txn.id]);

        res.json({
            success: true,
            transaction_id: txn.id,
            payout_id: simulatedPayoutId,
            message: 'Payout initiated successfully'
        });

    } catch (error) {
        console.error('Error processing sell request:', error);
        res.status(500).json({ error: 'Failed to process sell request' });
    }
});

// GET: Get transaction history
router.get('/transactions', authenticateToken, async (req, res) => {
    try {
        const { page = 1, limit = 20, type } = req.query;
        const offset = (page - 1) * limit;

        let query = `
            SELECT id, type, amount, credits, net_amount, processing_fee, status, 
                   created_at, completed_at, razorpay_order_id, razorpay_payment_id
            FROM vcreds_transactions 
            WHERE user_id = ?
        `;
        const params = [req.user.id];

        if (type && ['purchase', 'sell'].includes(type)) {
            query += ' AND type = ?';
            params.push(type);
        }

        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const [transactions] = await pool.execute(query, params);

        // Get total count for pagination
        let countQuery = 'SELECT COUNT(*) as total FROM vcreds_transactions WHERE user_id = ?';
        const countParams = [req.user.id];

        if (type && ['purchase', 'sell'].includes(type)) {
            countQuery += ' AND type = ?';
            countParams.push(type);
        }

        const [countResult] = await pool.execute(countQuery, countParams);
        const total = countResult[0].total;

        res.json({
            transactions,
            pagination: {
                current_page: parseInt(page),
                per_page: parseInt(limit),
                total,
                total_pages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ error: 'Failed to fetch transactions' });
    }
});

// GET: Get user's bank details
router.get('/bank-details', authenticateToken, async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT bank_details FROM user_profiles WHERE user_id = ?',
            [req.user.id]
        );

        if (rows.length === 0 || !rows[0].bank_details) {
            return res.json({ bank_details: null });
        }

        const bankDetails = JSON.parse(rows[0].bank_details);
        
        // Don't send full account number for security
        if (bankDetails.account_number) {
            const accountNumber = bankDetails.account_number;
            bankDetails.account_number_masked = 'XXXX' + accountNumber.slice(-4);
            delete bankDetails.account_number;
        }

        res.json({ bank_details: bankDetails });
    } catch (error) {
        console.error('Error fetching bank details:', error);
        res.status(500).json({ error: 'Failed to fetch bank details' });
    }
});

// POST: Save user's bank details
router.post('/bank-details', authenticateToken, async (req, res) => {
    try {
        const {
            account_holder,
            account_number,
            ifsc_code,
            bank_name,
            branch_name
        } = req.body;

        // Validate required fields
        if (!account_holder || !account_number || !ifsc_code || !bank_name) {
            return res.status(400).json({ error: 'Missing required bank details' });
        }

        // Validate IFSC code format
        const ifscRegex = /^[A-Z]{4}0[A-Z0-9]{6}$/;
        if (!ifscRegex.test(ifsc_code)) {
            return res.status(400).json({ error: 'Invalid IFSC code format' });
        }

        const bankDetails = {
            account_holder,
            account_number,
            ifsc_code,
            bank_name,
            branch_name,
            updated_at: new Date().toISOString()
        };

        // Upsert bank details
        await pool.execute(`
            INSERT INTO user_profiles (user_id, bank_details, updated_at) 
            VALUES (?, ?, NOW()) 
            ON DUPLICATE KEY UPDATE 
            bank_details = VALUES(bank_details), 
            updated_at = VALUES(updated_at)
        `, [req.user.id, JSON.stringify(bankDetails)]);

        res.json({ 
            success: true, 
            message: 'Bank details saved successfully' 
        });

    } catch (error) {
        console.error('Error saving bank details:', error);
        res.status(500).json({ error: 'Failed to save bank details' });
    }
});

module.exports = router;