-- VCreds Database Schema for Skill Vault
-- Run these SQL commands to set up the VCreds system

-- Add VCreds balance column to existing users table
ALTER TABLE users ADD COLUMN vcreds_balance INT DEFAULT 0 AFTER email;

-- Create user_profiles table for additional user information
CREATE TABLE IF NOT EXISTS user_profiles (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    bank_details JSON,
    profile_data JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_profile (user_id)
);

-- Create vcreds_transactions table to track all VCreds transactions
CREATE TABLE IF NOT EXISTS vcreds_transactions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    type ENUM('purchase', 'sell') NOT NULL,
    amount DECIMAL(10, 2) NOT NULL, -- Actual money amount
    credits INT NOT NULL, -- VCreds amount
    net_amount DECIMAL(10, 2) DEFAULT NULL, -- For sell transactions (after fees)
    processing_fee DECIMAL(10, 2) DEFAULT NULL, -- Processing fee for sell transactions
    razorpay_order_id VARCHAR(100) DEFAULT NULL,
    razorpay_payment_id VARCHAR(100) DEFAULT NULL,
    razorpay_payout_id VARCHAR(100) DEFAULT NULL,
    bank_details JSON DEFAULT NULL, -- Bank details for sell transactions
    status ENUM('pending', 'completed', 'failed', 'cancelled') DEFAULT 'pending',
    notes TEXT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP DEFAULT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user_id (user_id),
    INDEX idx_type (type),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at),
    INDEX idx_razorpay_order_id (razorpay_order_id),
    INDEX idx_razorpay_payment_id (razorpay_payment_id)
);

-- Create vcreds_log table for detailed credit tracking
CREATE TABLE IF NOT EXISTS vcreds_log (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    type ENUM('credit', 'debit') NOT NULL,
    amount INT NOT NULL, -- VCreds amount
    balance_before INT DEFAULT NULL,
    balance_after INT NOT NULL,
    description VARCHAR(255) NOT NULL,
    transaction_id INT DEFAULT NULL, -- Reference to vcreds_transactions
    job_id INT DEFAULT NULL, -- Reference to job if credit/debit is job-related
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (transaction_id) REFERENCES vcreds_transactions(id) ON DELETE SET NULL,
    INDEX idx_user_id (user_id),
    INDEX idx_type (type),
    INDEX idx_created_at (created_at),
    INDEX idx_transaction_id (transaction_id)
);

-- Create vcreds_plans table for purchase plan configurations
CREATE TABLE IF NOT EXISTS vcreds_plans (
    id INT PRIMARY KEY AUTO_INCREMENT,
    plan_name VARCHAR(50) NOT NULL UNIQUE,
    credits INT NOT NULL,
    base_amount DECIMAL(10, 2) NOT NULL,
    discounted_amount DECIMAL(10, 2) NOT NULL,
    discount_percentage DECIMAL(5, 2) DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    is_popular BOOLEAN DEFAULT FALSE,
    features JSON DEFAULT NULL,
    display_order INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_active (is_active),
    INDEX idx_display_order (display_order)
);

-- Insert default VCreds plans
INSERT INTO vcreds_plans (plan_name, credits, base_amount, discounted_amount, discount_percentage, is_popular, features, display_order) VALUES
('starter', 500, 500.00, 500.00, 0, FALSE, 
 JSON_ARRAY('Perfect for small projects', 'Instant credit activation', 'Secure transactions', '24/7 support'), 1),

('professional', 1000, 1000.00, 950.00, 5, TRUE, 
 JSON_ARRAY('Great for medium projects', '50 bonus credits included', 'Priority support', 'Transaction history'), 2),

('business', 2500, 2500.00, 2250.00, 10, FALSE, 
 JSON_ARRAY('Ideal for large projects', '250 bonus credits', 'Dedicated account manager', 'Advanced analytics'), 3),

('enterprise', 5000, 5000.00, 4250.00, 15, FALSE, 
 JSON_ARRAY('For enterprise projects', '750 bonus credits', 'Custom payment terms', 'Bulk project management'), 4);

-- Create vcreds_settings table for system configuration
CREATE TABLE IF NOT EXISTS vcreds_settings (
    id INT PRIMARY KEY AUTO_INCREMENT,
    setting_key VARCHAR(100) NOT NULL UNIQUE,
    setting_value TEXT NOT NULL,
    description TEXT DEFAULT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Insert default VCreds settings
INSERT INTO vcreds_settings (setting_key, setting_value, description) VALUES
('conversion_rate', '0.95', 'Rate at which VCreds are converted to money when selling (95%)'),
('processing_fee_rate', '0.025', 'Processing fee rate for selling VCreds (2.5%)'),
('minimum_sell_amount', '100', 'Minimum VCreds that can be sold at once'),
('maximum_sell_amount', '50000', 'Maximum VCreds that can be sold at once'),
('sell_processing_days', '5', 'Maximum days for processing sell requests'),
('razorpay_key_id', 'rzp_test_1234567890', 'Razorpay Key ID for payments'),
('platform_fee_percentage', '5', 'Platform fee percentage for job payments');

-- Create jobs_payments table to track job payments using VCreds
CREATE TABLE IF NOT EXISTS jobs_payments (
    id INT PRIMARY KEY AUTO_INCREMENT,
    job_id INT NOT NULL,
    freelancer_id INT NOT NULL,
    client_id INT NOT NULL,
    amount_vcreds INT NOT NULL, -- Amount in VCreds
    amount_money DECIMAL(10, 2) NOT NULL, -- Equivalent money amount
    platform_fee_vcreds INT DEFAULT 0, -- Platform fee in VCreds
    freelancer_receives_vcreds INT NOT NULL, -- VCreds freelancer receives
    status ENUM('pending', 'completed', 'disputed', 'refunded') DEFAULT 'pending',
    payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_date TIMESTAMP DEFAULT NULL,
    notes TEXT DEFAULT NULL,
    FOREIGN KEY (freelancer_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_job_id (job_id),
    INDEX idx_freelancer_id (freelancer_id),
    INDEX idx_client_id (client_id),
    INDEX idx_status (status),
    INDEX idx_payment_date (payment_date)
);

-- Create triggers to maintain balance consistency

DELIMITER //

-- Trigger to update balance_before in vcreds_log
CREATE TRIGGER before_vcreds_log_insert 
    BEFORE INSERT ON vcreds_log 
    FOR EACH ROW
BEGIN
    SELECT vcreds_balance INTO @current_balance 
    FROM users WHERE id = NEW.user_id;
    SET NEW.balance_before = @current_balance;
END //

-- Trigger to validate VCreds balance before deduction
CREATE TRIGGER before_users_vcreds_update 
    BEFORE UPDATE ON users 
    FOR EACH ROW
BEGIN
    IF NEW.vcreds_balance < 0 THEN
        SIGNAL SQLSTATE '45000' 
        SET MESSAGE_TEXT = 'Insufficient VCreds balance';
    END IF;
END //

DELIMITER ;

-- Create indexes for better performance
CREATE INDEX idx_users_vcreds_balance ON users(vcreds_balance);
CREATE INDEX idx_vcreds_transactions_user_date ON vcreds_transactions(user_id, created_at DESC);
CREATE INDEX idx_vcreds_log_user_date ON vcreds_log(user_id, created_at DESC);

-- Create view for user VCreds summary
CREATE VIEW user_vcreds_summary AS
SELECT 
    u.id as user_id,
    u.username,
    u.email,
    u.vcreds_balance,
    COALESCE(purchase_stats.total_purchased, 0) as total_purchased,
    COALESCE(purchase_stats.total_spent, 0) as total_spent,
    COALESCE(sell_stats.total_sold, 0) as total_sold,
    COALESCE(sell_stats.total_earned, 0) as total_earned,
    COALESCE(payment_stats.total_paid_out, 0) as total_paid_to_freelancers,
    COALESCE(earning_stats.total_received, 0) as total_received_from_jobs
FROM users u
LEFT JOIN (
    SELECT 
        user_id,
        SUM(credits) as total_purchased,
        SUM(amount) as total_spent
    FROM vcreds_transactions 
    WHERE type = 'purchase' AND status = 'completed'
    GROUP BY user_id
) purchase_stats ON u.id = purchase_stats.user_id
LEFT JOIN (
    SELECT 
        user_id,
        SUM(credits) as total_sold,
        SUM(net_amount) as total_earned
    FROM vcreds_transactions 
    WHERE type = 'sell' AND status = 'completed'
    GROUP BY user_id
) sell_stats ON u.id = sell_stats.user_id
LEFT JOIN (
    SELECT 
        client_id as user_id,
        SUM(amount_vcreds) as total_paid_out
    FROM jobs_payments 
    WHERE status = 'completed'
    GROUP BY client_id
) payment_stats ON u.id = payment_stats.user_id
LEFT JOIN (
    SELECT 
        freelancer_id as user_id,
        SUM(freelancer_receives_vcreds) as total_received
    FROM jobs_payments 
    WHERE status = 'completed'
    GROUP BY freelancer_id
) earning_stats ON u.id = earning_stats.user_id;