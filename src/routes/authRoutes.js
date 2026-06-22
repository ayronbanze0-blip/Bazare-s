'use strict';

const router = require('express').Router();
const { body } = require('express-validator');
const ctrl = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const { authLimiter, emailLimiter } = require('../middleware/rateLimiter');

const registerValidation = [
  body('name').trim().isLength({ min: 2, max: 100 }).withMessage('Nome deve ter entre 2 e 100 caracteres.'),
  body('email').isEmail().withMessage('Email inválido.').normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Palavra-passe deve ter no mínimo 8 caracteres.'),
  body('role').optional().isIn(['BUYER', 'SELLER', 'REVENDEDOR']).withMessage('Tipo de conta inválido.')
];

const loginValidation = [
  body('email').isEmail().withMessage('Email inválido.').normalizeEmail(),
  body('password').notEmpty().withMessage('Palavra-passe obrigatória.')
];

const resetPasswordValidation = [
  body('email').isEmail().normalizeEmail(),
  body('code').isLength({ min: 6, max: 6 }).withMessage('Código deve ter 6 dígitos.'),
  body('newPassword').isLength({ min: 8 }).withMessage('Nova palavra-passe deve ter no mínimo 8 caracteres.')
];

router.post('/register', authLimiter, registerValidation, ctrl.register);
router.post('/verify-email', authLimiter, ctrl.verifyEmail);
router.post('/resend-verification', emailLimiter, ctrl.resendVerification);
router.post('/login', authLimiter, loginValidation, ctrl.login);
router.post('/refresh', ctrl.refresh);
router.post('/logout', ctrl.logout);
router.post('/logout-all', authenticate, ctrl.logoutAll);
router.post('/forgot-password', emailLimiter, ctrl.forgotPassword);
router.post('/reset-password', authLimiter, resetPasswordValidation, ctrl.resetPassword);
router.get('/me', authenticate, ctrl.me);

module.exports = router;
