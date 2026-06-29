-- =====================================================
-- CLN Management System - Database Setup Script
-- Run this once to initialize the database
-- =====================================================

CREATE DATABASE IF NOT EXISTS cln_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE cln_db;

-- =====================================================
-- USERS TABLE (Admin & Employee)
-- =====================================================
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    role ENUM('admin', 'employee') NOT NULL DEFAULT 'employee',
    phone VARCHAR(15),
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- =====================================================
-- CUSTOMERS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS customers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(15) NOT NULL,
    email VARCHAR(150) NULL,
    address TEXT NOT NULL,
    area VARCHAR(100) NOT NULL,
    net_salary DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    total_obligation DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    added_by INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE RESTRICT
);

-- =====================================================
-- DOCUMENTS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS documents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NOT NULL,
    doc_type VARCHAR(100) NOT NULL,
    document_password VARCHAR(255) NULL,
    file_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    uploaded_by INT NOT NULL,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE RESTRICT
);

-- =====================================================
-- LOANS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS loans (
    id INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NOT NULL,
    amount DECIMAL(12, 2) NOT NULL,
    purpose VARCHAR(255),
    status ENUM('Pending', 'Approved', 'Loan Disbursed', 'Rejected', 'ABND', 'Other') NOT NULL DEFAULT 'Pending',
    notes TEXT,
    applied_by INT NOT NULL,
    approved_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT,
    FOREIGN KEY (applied_by) REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
);

-- =====================================================
-- PASSWORD RESET TOKENS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    used_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_password_reset_user_id (user_id),
    INDEX idx_password_reset_expires_at (expires_at),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- =====================================================
-- SEED DATA - Default Admin Account
-- Password: Admin@123 (bcrypt hashed)
-- =====================================================
INSERT IGNORE INTO users (name, email, password, role) VALUES (
    'System Admin',
    'dixitlendingsolution@gmail.com',
    '$2a$10$1Lofjvd8Rc2fQl91ZrTJdugL7RooMkOZHiBg/wtY8g3r80VRU9AIO',
    'admin'
);

-- =====================================================
-- Sample Employee (for testing)
-- Password: Employee@123 (bcrypt hashed)
-- =====================================================
INSERT IGNORE INTO users (name, email, password, role, phone) VALUES (
    'John Employee',
    'employee@cln.com',
    '$2a$10$1gYbyLfGOGh3mlPDrbq42uO.0JbTjVeN9EeWbaYJqU7nDA4aG0qb.',
    'employee',
    '9876543210'
);
