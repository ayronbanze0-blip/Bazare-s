-- Novos tipos de movimento da carteira: pagamento/recebimento de encomendas e reembolsos.
-- Ficam separados das transferências P2P para NÃO contarem no limite diário de transferências.
ALTER TYPE "WalletTxType" ADD VALUE IF NOT EXISTS 'PAGAMENTO_COMPRA';
ALTER TYPE "WalletTxType" ADD VALUE IF NOT EXISTS 'RECEBIMENTO_VENDA';
ALTER TYPE "WalletTxType" ADD VALUE IF NOT EXISTS 'REEMBOLSO_COMPRA';
ALTER TYPE "WalletTxType" ADD VALUE IF NOT EXISTS 'REEMBOLSO_VENDA';
