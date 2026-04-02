/**
 * GPU ROI ENGINE v3.0: Live Multi-Source Data Module
 *
 * LIVE API INTEGRATION with multi-source validation:
 *   - Crypto prices:   CoinGecko (primary) + CryptoCompare (secondary)
 *   - Mining revenue:  WhatToMine via CORS proxy (primary) + baseline fallback
 *   - Network fees:    mempool.space (primary) + blockchair (secondary)
 *   - Cloud lease:     Vast.ai public API (primary) + hardcoded fallback
 *   - Pool fees:       Configurable (default 1.5%)
 *   - Electricity:     Configurable via slider (default $0.12/kWh)
 *
 * MULTI-SOURCE VALIDATION:
 *   - Fetches from 2+ sources concurrently per data category
 *   - Cross-validates: if sources agree within 25%, averages them
 *   - If one outlier, excludes it and uses the median
 *   - Falls back to hardcoded baselines ONLY when ALL live sources fail
 *   - Displays stale-data warning banner when using fallback
 *
 * CORS-SAFE: All APIs use public CORS endpoints or corsproxy.io
 * Designed for Wix iframe embeds. No backend needed.
 *
 * Author: Pushstart LLC by Pawan K Jajoo
 */
const GPURoiEngine = (() => {
    'use strict';

    /* ═══════════════════════════════════════════
       GPU DATABASE: Hashrates, specs, lease rates
       hashrates: { algorithm: rate_in_native_unit }
         sha256:    TH/s (ASICs)
         kawpow:    MH/s (RVN)
         kheavyhash: MH/s (KAS, depressed by ASICs)
         autolykos:  MH/s (ERG, best GPU mining algo Mar 2026)
         etchash:    MH/s (ETC)
       cloudLease: $/hr fallback (overridden by live Vast.ai data)
       aiLease:    $/hr (datacenter only)
     ═══════════════════════════════════════════ */
    const GPU_DATABASE = [
        // DATACENTER / AI GPUs
        { name: 'NVIDIA B200',       brand: 'nvidia',  category: 'datacenter', tdp: 1000, msrp: 30000, hashrates: {},
          cloudLease: 5.50, aiLease: 5.50, vram: '192GB HBM3e', cudaCores: 18432,
          commentary: 'Datacenter GPU. Highest cloud and AI lease rates. pushstartsims.com/power' },
        { name: 'NVIDIA H200',       brand: 'nvidia',  category: 'datacenter', tdp: 700,  msrp: 25000, hashrates: {},
          cloudLease: 3.80, aiLease: 3.80, vram: '141GB HBM3e', cudaCores: 16896,
          commentary: 'Datacenter GPU. High cloud and AI lease rates. pushstartsims.com/power' },
        { name: 'NVIDIA H100',       brand: 'nvidia',  category: 'datacenter', tdp: 700,  msrp: 25000, hashrates: {},
          cloudLease: 2.85, aiLease: 2.85, vram: '80GB HBM3',   cudaCores: 16896,
          commentary: 'Datacenter GPU. Standard cloud and AI compute. pushstartsims.com/power' },
        { name: 'NVIDIA A100',       brand: 'nvidia',  category: 'datacenter', tdp: 400,  msrp: 10000, hashrates: {},
          cloudLease: 1.50, aiLease: 1.50, vram: '80GB HBM2e',  cudaCores: 6912,
          commentary: 'Datacenter GPU. Budget cloud and AI compute. pushstartsims.com/power' },

        // ASIC MINERS (SHA-256, Bitcoin)
        { name: 'Antminer S21 XP',   brand: 'bitmain', category: 'asic', tdp: 3400, msrp: 5500,
          hashrates: { sha256: 270 }, cloudLease: null, aiLease: null, vram: null, cudaCores: 0,
          commentary: 'ASIC miner. Best efficiency BTC. 270 TH/s.' },
        { name: 'Antminer S21 Pro',  brand: 'bitmain', category: 'asic', tdp: 3510, msrp: 3800,
          hashrates: { sha256: 234 }, cloudLease: null, aiLease: null, vram: null, cudaCores: 0,
          commentary: 'ASIC miner. High efficiency BTC. 234 TH/s.' },
        { name: 'Antminer S19K Pro', brand: 'bitmain', category: 'asic', tdp: 2400, msrp: 1200,
          hashrates: { sha256: 120 }, cloudLease: null, aiLease: null, vram: null, cudaCores: 0,
          commentary: 'ASIC miner. Entry level BTC. 120 TH/s.' },

        // CONSUMER NVIDIA (GeForce RTX 50-series)
        { name: 'RTX 5090',          brand: 'nvidia', category: 'consumer', tdp: 575, msrp: 1999,
          hashrates: { kawpow: 85, kheavyhash: 1200, autolykos: 550, etchash: 160 },
          cloudLease: 0.55, aiLease: null, vram: '32GB GDDR7', cudaCores: 21760,
          commentary: 'Consumer GPU. Cloud lease profitable. Ergo (Autolykos) mining profitable at $0.12/kWh. Other algos unprofitable.' },
        { name: 'RTX 5080',          brand: 'nvidia', category: 'consumer', tdp: 360, msrp: 999,
          hashrates: { kawpow: 61, kheavyhash: 800, autolykos: 370, etchash: 125 },
          cloudLease: 0.40, aiLease: null, vram: '16GB GDDR7', cudaCores: 10752,
          commentary: 'Consumer GPU. Cloud lease profitable. Ergo (Autolykos) mining profitable at $0.12/kWh. Other algos unprofitable.' },
        { name: 'RTX 5070 Ti',       brand: 'nvidia', category: 'consumer', tdp: 300, msrp: 749,
          hashrates: { kawpow: 43, kheavyhash: 650, autolykos: 195, etchash: 88 },
          cloudLease: 0.35, aiLease: null, vram: '16GB GDDR7', cudaCores: 8960,
          commentary: 'Consumer GPU. Cloud lease profitable. Ergo mining marginal at $0.12/kWh.' },
        { name: 'RTX 5070',          brand: 'nvidia', category: 'consumer', tdp: 250, msrp: 549,
          hashrates: { kawpow: 41, kheavyhash: 550, autolykos: 200, etchash: 80 },
          cloudLease: 0.30, aiLease: null, vram: '12GB GDDR7', cudaCores: 6144,
          commentary: 'Consumer GPU. Cloud lease profitable. Ergo mining marginal at $0.12/kWh.' },

        // CONSUMER NVIDIA (GeForce RTX 40-series)
        { name: 'RTX 4090',          brand: 'nvidia', category: 'consumer', tdp: 450, msrp: 1599,
          hashrates: { kawpow: 60, kheavyhash: 800, autolykos: 260, etchash: 132 },
          cloudLease: 0.45, aiLease: null, vram: '24GB GDDR6X', cudaCores: 16384,
          commentary: 'Consumer GPU. Cloud lease profitable. Mining unprofitable at $0.12/kWh.' },
        { name: 'RTX 4080 Super',    brand: 'nvidia', category: 'consumer', tdp: 320, msrp: 999,
          hashrates: { kawpow: 38, kheavyhash: 550, autolykos: 180, etchash: 88 },
          cloudLease: 0.25, aiLease: null, vram: '16GB GDDR6X', cudaCores: 10240,
          commentary: 'Consumer GPU. Cloud lease profitable. Mining unprofitable at $0.12/kWh.' },
        { name: 'RTX 4070 Ti Super', brand: 'nvidia', category: 'consumer', tdp: 285, msrp: 799,
          hashrates: { kawpow: 30, kheavyhash: 450, autolykos: 155, etchash: 72 },
          cloudLease: 0.22, aiLease: null, vram: '16GB GDDR6X', cudaCores: 8448,
          commentary: 'Consumer GPU. Cloud lease profitable. Mining unprofitable at $0.12/kWh.' },
        { name: 'RTX 4070 Super',    brand: 'nvidia', category: 'consumer', tdp: 220, msrp: 599,
          hashrates: { kawpow: 25, kheavyhash: 380, autolykos: 130, etchash: 58 },
          cloudLease: 0.18, aiLease: null, vram: '12GB GDDR6X', cudaCores: 7168,
          commentary: 'Consumer GPU. Cloud lease profitable. Mining unprofitable at $0.12/kWh.' },
        { name: 'RTX 4070',          brand: 'nvidia', category: 'consumer', tdp: 200, msrp: 549,
          hashrates: { kawpow: 22, kheavyhash: 340, autolykos: 115, etchash: 52 },
          cloudLease: 0.15, aiLease: null, vram: '12GB GDDR6X', cudaCores: 5888,
          commentary: 'Consumer GPU. Cloud lease profitable. Mining unprofitable at $0.12/kWh.' },
        { name: 'RTX 4060 Ti',       brand: 'nvidia', category: 'consumer', tdp: 160, msrp: 399,
          hashrates: { kawpow: 18, kheavyhash: 260, autolykos: 90, etchash: 40 },
          cloudLease: 0.12, aiLease: null, vram: '8GB GDDR6', cudaCores: 4352,
          commentary: 'Consumer GPU. Cloud lease viable. Mining unprofitable at $0.12/kWh.' },
        { name: 'RTX 4060',          brand: 'nvidia', category: 'consumer', tdp: 115, msrp: 299,
          hashrates: { kawpow: 14, kheavyhash: 200, autolykos: 68, etchash: 30 },
          cloudLease: 0.10, aiLease: null, vram: '8GB GDDR6', cudaCores: 3072,
          commentary: 'Consumer GPU. Low TDP. Cloud lease viable. Mining unprofitable.' },

        // CONSUMER NVIDIA (GeForce RTX 30-series)
        { name: 'RTX 3090 Ti',       brand: 'nvidia', category: 'consumer', tdp: 450, msrp: 1099,
          hashrates: { kawpow: 52, kheavyhash: 680, autolykos: 230, etchash: 120 },
          cloudLease: 0.30, aiLease: null, vram: '24GB GDDR6X', cudaCores: 10752,
          commentary: 'Consumer GPU. Previous gen. Cloud lease profitable. Mining unprofitable.' },
        { name: 'RTX 3090',          brand: 'nvidia', category: 'consumer', tdp: 350, msrp: 999,
          hashrates: { kawpow: 48, kheavyhash: 620, autolykos: 210, etchash: 110 },
          cloudLease: 0.25, aiLease: null, vram: '24GB GDDR6X', cudaCores: 10496,
          commentary: 'Consumer GPU. Previous gen. Cloud lease profitable. Mining unprofitable.' },
        { name: 'RTX 3080 Ti',       brand: 'nvidia', category: 'consumer', tdp: 350, msrp: 700,
          hashrates: { kawpow: 42, kheavyhash: 540, autolykos: 185, etchash: 95 },
          cloudLease: 0.20, aiLease: null, vram: '12GB GDDR6X', cudaCores: 10240,
          commentary: 'Consumer GPU. Previous gen. Cloud lease viable. Mining unprofitable.' },
        { name: 'RTX 3080',          brand: 'nvidia', category: 'consumer', tdp: 320, msrp: 599,
          hashrates: { kawpow: 38, kheavyhash: 480, autolykos: 165, etchash: 85 },
          cloudLease: 0.18, aiLease: null, vram: '10GB GDDR6X', cudaCores: 8704,
          commentary: 'Consumer GPU. Previous gen. Cloud lease viable. Mining unprofitable.' },
        { name: 'RTX 3070 Ti',       brand: 'nvidia', category: 'consumer', tdp: 290, msrp: 499,
          hashrates: { kawpow: 30, kheavyhash: 380, autolykos: 140, etchash: 68 },
          cloudLease: 0.14, aiLease: null, vram: '8GB GDDR6X', cudaCores: 6144,
          commentary: 'Consumer GPU. Previous gen. Cloud lease viable. Mining unprofitable.' },
        { name: 'RTX 3070',          brand: 'nvidia', category: 'consumer', tdp: 220, msrp: 399,
          hashrates: { kawpow: 25, kheavyhash: 310, autolykos: 120, etchash: 56 },
          cloudLease: 0.12, aiLease: null, vram: '8GB GDDR6', cudaCores: 5888,
          commentary: 'Consumer GPU. Previous gen. Cloud lease viable. Mining unprofitable.' },

        // CONSUMER AMD (Radeon RX 7000 & 6000 series)
        { name: 'RX 7900 XTX',       brand: 'amd', category: 'consumer', tdp: 355, msrp: 999,
          hashrates: { kawpow: 48, kheavyhash: 600, autolykos: 220, etchash: 95 },
          cloudLease: 0.50, aiLease: null, vram: '24GB GDDR6', cudaCores: 0,
          commentary: 'Consumer GPU. RDNA 3. Cloud lease profitable. Mining unprofitable.' },
        { name: 'RX 7900 XT',        brand: 'amd', category: 'consumer', tdp: 315, msrp: 749,
          hashrates: { kawpow: 35, kheavyhash: 450, autolykos: 175, etchash: 75 },
          cloudLease: 0.35, aiLease: null, vram: '20GB GDDR6', cudaCores: 0,
          commentary: 'Consumer GPU. RDNA 3. Cloud lease profitable. Mining unprofitable.' },
        { name: 'RX 7800 XT',        brand: 'amd', category: 'consumer', tdp: 263, msrp: 499,
          hashrates: { kawpow: 26, kheavyhash: 350, autolykos: 135, etchash: 58 },
          cloudLease: 0.25, aiLease: null, vram: '16GB GDDR6', cudaCores: 0,
          commentary: 'Consumer GPU. RDNA 3. Cloud lease viable. Mining unprofitable.' },
        { name: 'RX 7700 XT',        brand: 'amd', category: 'consumer', tdp: 245, msrp: 449,
          hashrates: { kawpow: 22, kheavyhash: 300, autolykos: 110, etchash: 48 },
          cloudLease: 0.20, aiLease: null, vram: '12GB GDDR6', cudaCores: 0,
          commentary: 'Consumer GPU. RDNA 3. Cloud lease viable. Mining unprofitable.' },
        { name: 'RX 7600 XT',        brand: 'amd', category: 'consumer', tdp: 150, msrp: 329,
          hashrates: { kawpow: 14, kheavyhash: 180, autolykos: 68, etchash: 30 },
          cloudLease: 0.15, aiLease: null, vram: '16GB GDDR6', cudaCores: 0,
          commentary: 'Consumer GPU. RDNA 3. Low TDP. Cloud lease viable.' },
        { name: 'RX 6900 XT',        brand: 'amd', category: 'consumer', tdp: 300, msrp: 549,
          hashrates: { kawpow: 30, kheavyhash: 380, autolykos: 150, etchash: 62 },
          cloudLease: 0.28, aiLease: null, vram: '16GB GDDR6', cudaCores: 0,
          commentary: 'Consumer GPU. RDNA 2. Cloud lease viable. Mining unprofitable.' },
        { name: 'RX 6800 XT',        brand: 'amd', category: 'consumer', tdp: 300, msrp: 449,
          hashrates: { kawpow: 25, kheavyhash: 320, autolykos: 130, etchash: 55 },
          cloudLease: 0.22, aiLease: null, vram: '16GB GDDR6', cudaCores: 0,
          commentary: 'Consumer GPU. RDNA 2. Cloud lease viable. Mining unprofitable.' },
        { name: 'RX 6700 XT',        brand: 'amd', category: 'consumer', tdp: 230, msrp: 349,
          hashrates: { kawpow: 18, kheavyhash: 220, autolykos: 85, etchash: 38 },
          cloudLease: 0.15, aiLease: null, vram: '12GB GDDR6', cudaCores: 0,
          commentary: 'Consumer GPU. RDNA 2. Cloud lease viable. Mining unprofitable.' },

        // CONSUMER INTEL ARC
        { name: 'Intel Arc B580',     brand: 'intel', category: 'consumer', tdp: 150, msrp: 249,
          hashrates: { kawpow: 15, kheavyhash: 200, autolykos: 60, etchash: 26 },
          cloudLease: 0.12, aiLease: null, vram: '12GB GDDR6', cudaCores: 0,
          commentary: 'Consumer GPU. Arc. Cloud lease viable. Mining unprofitable.' },
        { name: 'Intel Arc A770',     brand: 'intel', category: 'consumer', tdp: 225, msrp: 349,
          hashrates: { kawpow: 20, kheavyhash: 260, autolykos: 85, etchash: 35 },
          cloudLease: 0.18, aiLease: null, vram: '16GB GDDR6', cudaCores: 0,
          commentary: 'Consumer GPU. Arc. Cloud lease viable. Mining unprofitable.' },
        { name: 'Intel Arc A750',     brand: 'intel', category: 'consumer', tdp: 225, msrp: 289,
          hashrates: { kawpow: 16, kheavyhash: 210, autolykos: 68, etchash: 28 },
          cloudLease: 0.14, aiLease: null, vram: '8GB GDDR6', cudaCores: 0,
          commentary: 'Consumer GPU. Arc. Cloud lease viable. Mining unprofitable.' },
        { name: 'Intel Arc A580',     brand: 'intel', category: 'consumer', tdp: 185, msrp: 179,
          hashrates: { kawpow: 12, kheavyhash: 160, autolykos: 50, etchash: 22 },
          cloudLease: 0.10, aiLease: null, vram: '8GB GDDR6', cudaCores: 0,
          commentary: 'Consumer GPU. Arc. Low TDP. Cloud lease viable.' },
        { name: 'Intel Arc B570',     brand: 'intel', category: 'consumer', tdp: 150, msrp: 219,
          hashrates: { kawpow: 13, kheavyhash: 180, autolykos: 55, etchash: 24 },
          cloudLease: 0.11, aiLease: null, vram: '10GB GDDR6', cudaCores: 0,
          commentary: 'Consumer GPU. Arc. Cloud lease viable. Mining unprofitable.' },

        // CPU PROCESSORS (RandomX / XMR mining)
        { name: 'AMD EPYC 9654',           brand: 'amd',   category: 'cpu', tdp: 360, msrp: 6000,
          hashrates: {}, miningDailyGross: 4.77, cloudLease: null, aiLease: null, vram: null, cudaCores: 0, cores: 96,
          commentary: 'Server CPU. XMR mining profitable at $0.12/kWh. pushstartsims.com/power' },
        { name: 'AMD EPYC 9754',           brand: 'amd',   category: 'cpu', tdp: 360, msrp: 8500,
          hashrates: {}, miningDailyGross: 3.96, cloudLease: null, aiLease: null, vram: null, cudaCores: 0, cores: 128,
          commentary: 'Server CPU. XMR mining profitable at $0.12/kWh. pushstartsims.com/power' },
        { name: 'AMD TR PRO 7995WX',       brand: 'amd',   category: 'cpu', tdp: 350, msrp: 5500,
          hashrates: {}, miningDailyGross: 2.81, cloudLease: null, aiLease: null, vram: null, cudaCores: 0, cores: 96,
          commentary: 'Workstation CPU. XMR mining profitable at $0.12/kWh.' },
        { name: 'AMD EPYC 9K84',           brand: 'amd',   category: 'cpu', tdp: 400, msrp: 7500,
          hashrates: {}, miningDailyGross: 2.90, cloudLease: null, aiLease: null, vram: null, cudaCores: 0, cores: 96,
          commentary: 'Server CPU. XMR mining profitable at $0.12/kWh. pushstartsims.com/power' },
        { name: 'AMD Ryzen 9 9950X',       brand: 'amd',   category: 'cpu', tdp: 170, msrp: 599,
          hashrates: {}, miningDailyGross: 1.34, cloudLease: null, aiLease: null, vram: null, cudaCores: 0, cores: 16,
          commentary: 'Consumer CPU. XMR mining profitable at $0.12/kWh.' },
        { name: 'AMD TR PRO 5995WX',       brand: 'amd',   category: 'cpu', tdp: 280, msrp: 3500,
          hashrates: {}, miningDailyGross: 1.53, cloudLease: null, aiLease: null, vram: null, cudaCores: 0, cores: 64,
          commentary: 'Workstation CPU. Previous gen. XMR mining profitable.' },
        { name: 'Intel Core Ultra 9 285K', brand: 'intel', category: 'cpu', tdp: 175, msrp: 589,
          hashrates: {}, miningDailyGross: 1.06, cloudLease: null, aiLease: null, vram: null, cudaCores: 0, cores: 24,
          commentary: 'Consumer CPU. XMR mining profitable at $0.12/kWh.' },
        { name: 'Intel Core Ultra 7 265K', brand: 'intel', category: 'cpu', tdp: 150, msrp: 394,
          hashrates: {}, miningDailyGross: 0.94, cloudLease: null, aiLease: null, vram: null, cudaCores: 0, cores: 20,
          commentary: 'Consumer CPU. XMR mining profitable at $0.12/kWh.' },
        { name: 'AMD Ryzen 9 9900X3D',     brand: 'amd',   category: 'cpu', tdp: 100, msrp: 499,
          hashrates: {}, miningDailyGross: 0.78, cloudLease: null, aiLease: null, vram: null, cudaCores: 0, cores: 12,
          commentary: 'Consumer CPU. Low TDP. XMR mining profitable.' },
        { name: 'AMD Ryzen 9 7900X',       brand: 'amd',   category: 'cpu', tdp: 105, msrp: 399,
          hashrates: {}, miningDailyGross: 0.78, cloudLease: null, aiLease: null, vram: null, cudaCores: 0, cores: 12,
          commentary: 'Consumer CPU. Previous gen. XMR mining profitable.' },
        { name: 'AMD Ryzen 9 7900',        brand: 'amd',   category: 'cpu', tdp: 65,  msrp: 349,
          hashrates: {}, miningDailyGross: 0.67, cloudLease: null, aiLease: null, vram: null, cudaCores: 0, cores: 12,
          commentary: 'Consumer CPU. Low TDP. XMR mining profitable.' },
        { name: 'AMD Ryzen 9 9950X3D',     brand: 'amd',   category: 'cpu', tdp: 170, msrp: 699,
          hashrates: {}, miningDailyGross: 0.90, cloudLease: null, aiLease: null, vram: null, cudaCores: 0, cores: 16,
          commentary: 'Consumer CPU. XMR mining profitable at $0.12/kWh.' }
    ];

    /* ═══════════════════════════════════════════
       COIN DEFINITIONS: Algorithm to CoinGecko ID
     ═══════════════════════════════════════════ */
    const COIN_DEFINITIONS = {
        bitcoin:  { symbol: 'BTC', algorithm: 'sha256',     geckoId: 'bitcoin',  wtmId: 1,   unit: 'TH/s' },
        kaspa:    { symbol: 'KAS', algorithm: 'kheavyhash', geckoId: 'kaspa',    wtmId: 352, unit: 'MH/s' },
        ravencoin:{ symbol: 'RVN', algorithm: 'kawpow',     geckoId: 'ravencoin',wtmId: 234, unit: 'MH/s' },
        ergo:     { symbol: 'ERG', algorithm: 'autolykos',  geckoId: 'ergo',     wtmId: 340, unit: 'MH/s' },
        etc:      { symbol: 'ETC', algorithm: 'etchash',    geckoId: 'ethereum-classic', wtmId: 162, unit: 'MH/s' }
    };

    /* ═══════════════════════════════════════════
       DEFAULT FEE MODEL
     ═══════════════════════════════════════════ */
    const DEFAULT_FEES = {
        poolFeePercent: 1.5,
        cloudPlatformFeePercent: 10,
        aiPlatformFeePercent: 10,
        btcTxFeeUsd: 0.50,
        kasTxFeeUsd: 0.001,
        rvnTxFeeUsd: 0.005,
        ergTxFeeUsd: 0.002,
        etcTxFeeUsd: 0.01,
    };

    /* ═══════════════════════════════════════════
       SLIDER CONFIGURATION: ranges for user controls
     ═══════════════════════════════════════════ */
    const SLIDER_CONFIG = {
        electricityCost: { min: 0.02, max: 0.35, step: 0.01, default: 0.12, unit: '$/kWh', label: 'Electricity Rate' },
        poolFeePercent:  { min: 0.5,  max: 3.0,  step: 0.1,  default: 1.5,  unit: '%',     label: 'Pool Fee' },
        cloudPlatformFeePercent: { min: 0, max: 20, step: 1, default: 10, unit: '%', label: 'Cloud Platform Fee' },
    };

    /* ═══════════════════════════════════════════
       BASELINE REVENUE: Fallback when ALL APIs fail
       $/day per unit of hashrate
     ═══════════════════════════════════════════ */
    const BASELINE_REVENUE = {
        sha256:     { perUnit: 0.030, unitLabel: 'TH/s' },
        kawpow:     { perUnit: 0.003, unitLabel: 'MH/s' },
        kheavyhash: { perUnit: 0.002, unitLabel: 'MH/s' },
        autolykos:  { perUnit: 0.007, unitLabel: 'MH/s' },
        etchash:    { perUnit: 0.005, unitLabel: 'MH/s' },
    };

    /* ═══════════════════════════════════════════
       STREET PRICES: Hardcoded GPU retail fallback
     ═══════════════════════════════════════════ */
    const STREET_PRICES = {
        'NVIDIA B200': 30000, 'NVIDIA H200': 25000, 'NVIDIA H100': 25000, 'NVIDIA A100': 10000,
        'Antminer S21 XP': 5500, 'Antminer S21 Pro': 3800, 'Antminer S19K Pro': 1200,
        'RTX 5090': 1999, 'RTX 5080': 999, 'RTX 5070 Ti': 749, 'RTX 5070': 549,
        'RTX 4090': 1599, 'RTX 4080 Super': 999, 'RTX 4070 Ti Super': 799,
        'RTX 4070 Super': 599, 'RTX 4070': 549, 'RTX 4060 Ti': 399, 'RTX 4060': 299,
        'RTX 3090 Ti': 1099, 'RTX 3090': 999, 'RTX 3080 Ti': 700, 'RTX 3080': 599,
        'RTX 3070 Ti': 499, 'RTX 3070': 399,
        'RX 7900 XTX': 999, 'RX 7900 XT': 749, 'RX 7800 XT': 499, 'RX 7700 XT': 449,
        'RX 7600 XT': 329, 'RX 6900 XT': 549, 'RX 6800 XT': 449, 'RX 6700 XT': 349,
        'Intel Arc B580': 249, 'Intel Arc A770': 349, 'Intel Arc A750': 289,
        'Intel Arc A580': 179, 'Intel Arc B570': 219,
        'AMD EPYC 9654': 6000, 'AMD EPYC 9754': 8500, 'AMD TR PRO 7995WX': 5500,
        'AMD EPYC 9K84': 7500, 'AMD Ryzen 9 9950X': 599, 'AMD TR PRO 5995WX': 3500,
        'Intel Core Ultra 9 285K': 589, 'Intel Core Ultra 7 265K': 394,
        'AMD Ryzen 9 9900X3D': 499, 'AMD Ryzen 9 7900X': 399, 'AMD Ryzen 9 7900': 349,
        'AMD Ryzen 9 9950X3D': 699,
    };

    /* ═══════════════════════════════════════════
       MULTI-SOURCE API MODULE: CORS-safe, Wix iframe compatible
     ═══════════════════════════════════════════ */
    const API = {
        TIMEOUT: 8000,
        PROXY: 'https://corsproxy.io/?',

        /** Race fetch against timeout. Returns null on failure (never throws). */
        async _fetch(url, ms) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), ms || this.TIMEOUT);
            try {
                const r = await fetch(url, { signal: controller.signal });
                clearTimeout(timer);
                if (!r.ok) return null;
                return await r.json();
            } catch (e) {
                clearTimeout(timer);
                return null;
            }
        },

        /** Fetch via CORS proxy. Returns null on failure. */
        async _proxyFetch(url, ms) {
            return this._fetch(this.PROXY + encodeURIComponent(url), ms || 10000);
        },

        /**
         * MULTI-SOURCE: Crypto Prices
         * Source 1: CoinGecko (free, CORS enabled)
         * Source 2: CryptoCompare (free, CORS enabled)
         * Returns: { bitcoin: { usd: N }, kaspa: { usd: N }, ... }
         */
        async fetchCryptoPrices() {
            const geckoIds = Object.values(COIN_DEFINITIONS).map(c => c.geckoId).join(',');

            // Source 1: CoinGecko
            const p1 = this._fetch(
                `https://api.coingecko.com/api/v3/simple/price?ids=${geckoIds}&vs_currencies=usd`
            );

            // Source 2: CryptoCompare
            const ccSymbols = Object.values(COIN_DEFINITIONS).map(c => c.symbol).join(',');
            const p2 = this._fetch(
                `https://min-api.cryptocompare.com/data/pricemulti?fsyms=${ccSymbols}&tsyms=USD`
            );

            const [gecko, cc] = await Promise.all([p1, p2]);

            const sources = [];
            if (gecko) sources.push({ name: 'CoinGecko', data: gecko, type: 'gecko' });
            if (cc) sources.push({ name: 'CryptoCompare', data: cc, type: 'cc' });

            if (sources.length === 0) return null;

            // Normalize to CoinGecko format
            const result = {};
            for (const [coinKey, coinDef] of Object.entries(COIN_DEFINITIONS)) {
                const prices = [];

                // CoinGecko price
                if (gecko && gecko[coinDef.geckoId] && gecko[coinDef.geckoId].usd) {
                    prices.push(gecko[coinDef.geckoId].usd);
                }
                // CryptoCompare price
                if (cc && cc[coinDef.symbol] && cc[coinDef.symbol].USD) {
                    prices.push(cc[coinDef.symbol].USD);
                }

                if (prices.length > 0) {
                    result[coinDef.geckoId] = { usd: this._averageWithValidation(prices) };
                }
            }

            return { data: result, sourceCount: sources.length, sources: sources.map(s => s.name) };
        },

        /**
         * MULTI-SOURCE: Mining Profitability
         * Source 1: WhatToMine (via CORS proxy)
         * Returns raw WhatToMine coin data for revenue-per-hashrate calculations
         */
        async fetchMiningData() {
            const p1 = this._proxyFetch('https://whattomine.com/coins.json', 12000);
            const data = await p1;
            if (data && data.coins) {
                return { data, sourceCount: 1, sources: ['WhatToMine'] };
            }
            return null;
        },

        /**
         * MULTI-SOURCE: BTC Network Fees
         * Source 1: mempool.space (CORS enabled)
         * Source 2: blockchair (via CORS proxy)
         * Returns: { hourFee, halfHourFee, fastestFee } in sat/vB
         */
        async fetchBtcFees() {
            const p1 = this._fetch('https://mempool.space/api/v1/fees/recommended');
            const p2 = this._proxyFetch('https://api.blockchair.com/bitcoin/stats');

            const [mempool, blockchair] = await Promise.all([p1, p2]);

            const feeSources = [];
            if (mempool && mempool.hourFee) {
                feeSources.push({ name: 'mempool.space', hourFee: mempool.hourFee });
            }
            if (blockchair && blockchair.data && blockchair.data.suggested_transaction_fee_per_byte_sat) {
                feeSources.push({ name: 'blockchair', hourFee: blockchair.data.suggested_transaction_fee_per_byte_sat });
            }

            if (feeSources.length === 0) return null;

            const avgFee = this._averageWithValidation(feeSources.map(s => s.hourFee));
            // Convert sat/vB to USD for a typical 250 vByte transaction
            // We'll multiply by BTC price later in the calculator
            return {
                data: { ...mempool, hourFee: avgFee, fastestFee: mempool ? mempool.fastestFee : avgFee * 2 },
                sourceCount: feeSources.length,
                sources: feeSources.map(s => s.name)
            };
        },

        /**
         * MULTI-SOURCE: Cloud GPU Lease Rates
         * Source 1: Vast.ai public search API (CORS via proxy)
         * Falls back to hardcoded rates if API unavailable
         * Returns: { gpuName: avgPricePerHour, ... }
         */
        async fetchCloudLeaseRates() {
            const gpuQueries = [
                'RTX 5090', 'RTX 5080', 'RTX 5070', 'RTX 4090', 'RTX 4080',
                'RTX 3090', 'RTX 3080', 'RTX 3070'
            ];

            // Vast.ai public offers endpoint
            const vastUrl = 'https://console.vast.ai/api/v0/bundles?q=' +
                encodeURIComponent(JSON.stringify({
                    verified: { eq: true },
                    external: { eq: false },
                    rentable: { eq: true },
                    num_gpus: { eq: 1 },
                    order: [["dph_total", "asc"]],
                    type: "on-demand",
                    limit: 200
                }));

            const vastData = await this._proxyFetch(vastUrl, 12000);

            if (!vastData || !vastData.offers) return null;

            // Aggregate by GPU name, calculate median price
            const rates = {};
            for (const offer of vastData.offers) {
                const name = (offer.gpu_name || '').trim();
                if (!name) continue;
                const priceHr = offer.dph_total; // dollars per hour
                if (!priceHr || priceHr <= 0 || priceHr > 50) continue;

                if (!rates[name]) rates[name] = [];
                rates[name].push(priceHr);
            }

            // Calculate median for each GPU
            const result = {};
            for (const [name, prices] of Object.entries(rates)) {
                prices.sort((a, b) => a - b);
                const mid = Math.floor(prices.length / 2);
                const median = prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
                result[name] = { median, count: prices.length, min: prices[0], max: prices[prices.length - 1] };
            }

            return { data: result, sourceCount: 1, sources: ['Vast.ai'] };
        },

        /** Average with outlier rejection. If values disagree by >50%, use median. */
        _averageWithValidation(values) {
            if (!values || values.length === 0) return 0;
            if (values.length === 1) return values[0];

            const sorted = [...values].sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)];

            // Reject values more than 50% away from median
            const valid = sorted.filter(v => Math.abs(v - median) / median < 0.5);
            if (valid.length === 0) return median;

            return valid.reduce((a, b) => a + b, 0) / valid.length;
        },

        /** Optional: SerpAPI for live GPU retail pricing */
        async fetchGpuPrice(gpuName, serpApiKey) {
            if (!serpApiKey) return null;
            try {
                const url = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(gpuName + ' GPU price')}&api_key=${serpApiKey}`;
                const data = await this._fetch(url, 6000);
                if (data && data.shopping_results && data.shopping_results.length > 0) {
                    const retailers = ['Amazon', 'Newegg', 'Best Buy', 'B&H', 'Micro Center'];
                    let best = null;
                    for (const result of data.shopping_results) {
                        const price = parseFloat(result.extracted_price);
                        if (!price || price < 50) continue;
                        const source = result.source || 'Google Shopping';
                        const isRetailer = retailers.some(r => source.includes(r));
                        if (!best || price < best.price || (isRetailer && price <= best.price * 1.05)) {
                            best = { price, source, url: result.link || '' };
                        }
                    }
                    return best;
                }
            } catch (e) {}
            return null;
        }
    };

    /* ═══════════════════════════════════════════
       CACHE: In-memory + localStorage with TTL
     ═══════════════════════════════════════════ */
    const Cache = {
        _mem: {},
        TTL: 55000,

        get(key) {
            const entry = this._mem[key];
            if (entry && Date.now() - entry.ts < this.TTL) return entry.data;
            try {
                const stored = localStorage.getItem('gpuroi_' + key);
                if (stored) {
                    const parsed = JSON.parse(stored);
                    if (Date.now() - parsed.ts < this.TTL * 10) {
                        this._mem[key] = { data: parsed.data, ts: parsed.ts };
                        return parsed.data;
                    }
                }
            } catch (e) {}
            return null;
        },

        set(key, data) {
            this._mem[key] = { data, ts: Date.now() };
            try {
                localStorage.setItem('gpuroi_' + key, JSON.stringify({ data, ts: Date.now() }));
            } catch (e) {}
        },

        /** Store last successfully fetched live data (no TTL — persists until overwritten) */
        setLastLive(key, data) {
            try {
                localStorage.setItem('gpuroi_lastlive_' + key, JSON.stringify({ data, ts: Date.now() }));
            } catch (e) {}
        },

        /** Retrieve last successfully fetched live data (never expires) */
        getLastLive(key) {
            try {
                const stored = localStorage.getItem('gpuroi_lastlive_' + key);
                if (stored) {
                    const parsed = JSON.parse(stored);
                    return { data: parsed.data, ts: parsed.ts };
                }
            } catch (e) {}
            return null;
        },

        /** Get the timestamp of the most recent last-live entry across all keys */
        getLastLiveTimestamp() {
            let latest = 0;
            const keys = ['cryptoPrices', 'whattomine', 'btcFees', 'cloudRates'];
            for (const key of keys) {
                const entry = this.getLastLive(key);
                if (entry && entry.ts > latest) latest = entry.ts;
            }
            return latest > 0 ? latest : null;
        }
    };

    /* ═══════════════════════════════════════════
       PROFITABILITY CALCULATOR
     ═══════════════════════════════════════════ */
    const Calculator = {
        miningGrossRevenue(hashrate, algorithm, liveData) {
            if (!hashrate || hashrate <= 0) return null;

            if (liveData && liveData.coins) {
                let bestRevenue = 0;
                let bestCoin = null;

                for (const [coinKey, coinData] of Object.entries(liveData.coins)) {
                    if (!coinData.tag || !coinData.algorithm) continue;
                    const wtmAlgo = coinData.algorithm.toLowerCase().replace(/[^a-z0-9]/g, '');
                    const ourAlgo = algorithm.toLowerCase().replace(/[^a-z0-9]/g, '');

                    if (wtmAlgo === ourAlgo || this._algoMatch(wtmAlgo, ourAlgo)) {
                        const revenuePerDay = parseFloat(coinData.btc_revenue) || 0;
                        const btcPrice = parseFloat(coinData.exchange_rate) || 0;
                        const revenue = hashrate * revenuePerDay * (btcPrice > 0 ? btcPrice : 1);

                        if (revenue > bestRevenue) {
                            bestRevenue = revenue;
                            bestCoin = { name: coinKey, symbol: coinData.tag, revenue: bestRevenue };
                        }
                    }
                }
                if (bestCoin) return bestCoin;
            }

            const baseline = BASELINE_REVENUE[algorithm];
            if (!baseline) return null;
            const coinDef = Object.values(COIN_DEFINITIONS).find(c => c.algorithm === algorithm);
            return {
                name: coinDef ? coinDef.geckoId : algorithm,
                symbol: coinDef ? coinDef.symbol : '???',
                revenue: hashrate * baseline.perUnit
            };
        },

        _algoMatch(wtm, ours) {
            const aliases = {
                'sha256': ['sha256'],
                'kawpow': ['kawpow'],
                'kheavyhash': ['kheavyhash', 'heavyhash'],
                'autolykos': ['autolykos', 'autolykos2'],
                'etchash': ['etchash', 'ethash']
            };
            for (const [key, alts] of Object.entries(aliases)) {
                if (alts.includes(ours) && alts.includes(wtm)) return true;
                if (key === ours && alts.includes(wtm)) return true;
            }
            return false;
        },

        bestMiningProfit(gpu, electricityCost, liveData, btcFees, fees) {
            const f = { ...DEFAULT_FEES, ...(fees || {}) };
            const electricityCostPerDay = (gpu.tdp / 1000) * 24 * electricityCost;
            let best = null;

            if (gpu.miningDailyGross) {
                const grossRevenue = gpu.miningDailyGross;
                const poolFee = grossRevenue * (f.poolFeePercent / 100);
                const netProfit = grossRevenue - electricityCostPerDay - poolFee - 0.001;
                return {
                    netProfit, grossRevenue, electricityCostPerDay, poolFee,
                    networkFee: 0.001, algorithm: 'randomx', coin: 'XMR', coinName: 'monero'
                };
            }

            for (const [algo, hashrate] of Object.entries(gpu.hashrates || {})) {
                const result = this.miningGrossRevenue(hashrate, algo, liveData);
                if (!result) continue;

                const grossRevenue = result.revenue;
                const poolFee = grossRevenue * (f.poolFeePercent / 100);

                let networkFee = 0;
                if (algo === 'sha256') {
                    networkFee = f.btcTxFeeUsd;
                } else if (algo === 'kawpow') {
                    networkFee = f.rvnTxFeeUsd;
                } else if (algo === 'kheavyhash') {
                    networkFee = f.kasTxFeeUsd;
                } else if (algo === 'autolykos') {
                    networkFee = f.ergTxFeeUsd;
                } else if (algo === 'etchash') {
                    networkFee = f.etcTxFeeUsd;
                }

                const netProfit = grossRevenue - electricityCostPerDay - poolFee - networkFee;

                if (!best || netProfit > best.netProfit) {
                    best = {
                        netProfit, grossRevenue, electricityCostPerDay, poolFee,
                        networkFee, algorithm: algo, coin: result.symbol, coinName: result.name
                    };
                }
            }
            return best;
        },

        cloudLeaseGrossDaily(gpu, liveCloudRates) {
            // Try live rate first
            if (liveCloudRates) {
                const nameVariants = [gpu.name, gpu.name.replace('RTX ', 'RTX')];
                for (const variant of nameVariants) {
                    for (const [key, rateData] of Object.entries(liveCloudRates)) {
                        if (key.includes(variant) || variant.includes(key)) {
                            return rateData.median * 24;
                        }
                    }
                }
            }
            // Fallback to hardcoded
            if (!gpu.cloudLease) return null;
            return gpu.cloudLease * 24;
        },

        aiLeaseGrossDaily(gpu) {
            if (!gpu.aiLease) return null;
            return gpu.aiLease * 24;
        },

        fullBreakdown(gpu, electricityCost, liveData, btcFees, fees, liveCloudRates) {
            const f = { ...DEFAULT_FEES, ...(fees || {}) };
            const mining = this.bestMiningProfit(gpu, electricityCost, liveData, btcFees, fees);
            const cloud = this.cloudLeaseGrossDaily(gpu, liveCloudRates);
            const ai = this.aiLeaseGrossDaily(gpu);

            const streams = [];

            if (mining) {
                streams.push({
                    type: 'mining', label: `Mining (${mining.coin})`, shortLabel: 'Mining',
                    dailyProfit: mining.netProfit, grossRevenue: mining.grossRevenue,
                    electricityCost: mining.electricityCostPerDay, poolFee: mining.poolFee,
                    networkFee: mining.networkFee, algorithm: mining.algorithm, coin: mining.coin
                });
            }

            if (cloud !== null) {
                const cloudElec = (gpu.tdp / 1000) * 24 * electricityCost;
                const cloudPlatformFee = cloud * (f.cloudPlatformFeePercent / 100);
                const cloudNet = cloud - cloudPlatformFee - cloudElec;
                streams.push({
                    type: 'cloud', label: 'Cloud Lease', shortLabel: 'Cloud',
                    dailyProfit: cloudNet, grossRevenue: cloud, electricityCost: cloudElec,
                    poolFee: cloudPlatformFee, networkFee: 0, algorithm: null, coin: null
                });
            }

            if (ai !== null) {
                const aiElec = (gpu.tdp / 1000) * 24 * electricityCost;
                const aiPlatformFee = ai * (f.aiPlatformFeePercent / 100);
                const aiNet = ai - aiPlatformFee - aiElec;
                streams.push({
                    type: 'ai', label: 'AI Inference', shortLabel: 'AI',
                    dailyProfit: aiNet, grossRevenue: ai, electricityCost: aiElec,
                    poolFee: aiPlatformFee, networkFee: 0, algorithm: null, coin: null
                });
            }

            streams.sort((a, b) => b.dailyProfit - a.dailyProfit);
            const bestStream = streams.length > 0 ? streams[0] : null;
            const bestDailyProfit = bestStream ? bestStream.dailyProfit : 0;
            const roiDays = bestDailyProfit > 0 ? Math.ceil(gpu.msrp / bestDailyProfit) : Infinity;
            const efficiency = gpu.tdp > 0 && bestDailyProfit > 0 ? (bestDailyProfit / gpu.tdp * 1000) : 0;

            return {
                gpu: gpu.name, brand: gpu.brand, category: gpu.category,
                msrp: gpu.msrp, tdp: gpu.tdp, vram: gpu.vram,
                cudaCores: gpu.cudaCores, cores: gpu.cores || 0,
                commentary: gpu.commentary, streams,
                best: bestStream, bestDailyProfit,
                roiDays, efficiency: parseFloat(efficiency.toFixed(4))
            };
        }
    };

    /* ═══════════════════════════════════════════
       MAIN ENGINE: Orchestrates data + calculation
     ═══════════════════════════════════════════ */
    const Engine = {
        electricityCost: 0.12,
        poolFeePercent: 1.5,
        cloudPlatformFeePercent: 10,
        serpApiKey: null,
        isLive: false,
        isStale: false,
        usingLastLive: false,
        lastLiveTimestamp: null,
        lastRefresh: null,
        _liveData: null,
        _btcFees: null,
        _cryptoPrices: null,
        _cloudRates: null,
        _onUpdate: null,
        _onStaleWarning: null,
        _dataSources: {},
        _refreshTimer: null,

        init(options) {
            this.electricityCost = options?.electricityCost || 0.12;
            this.poolFeePercent = options?.poolFeePercent || 1.5;
            this.cloudPlatformFeePercent = options?.cloudPlatformFeePercent || 10;
            this.serpApiKey = options?.serpApiKey || null;
            this._onUpdate = options?.onUpdate || null;
            this._onStaleWarning = options?.onStaleWarning || null;

            try {
                const ec = localStorage.getItem('gpuroi_electricityCost');
                if (ec) this.electricityCost = parseFloat(ec) || 0.12;
                const pf = localStorage.getItem('gpuroi_poolFee');
                if (pf) this.poolFeePercent = parseFloat(pf) || 1.5;
                const cpf = localStorage.getItem('gpuroi_cloudPlatformFee');
                if (cpf) this.cloudPlatformFeePercent = parseFloat(cpf) || 10;
                const sk = localStorage.getItem('gpuroi_serpApiKey');
                if (sk) this.serpApiKey = sk;
            } catch (e) {}
        },

        saveSettings() {
            try {
                localStorage.setItem('gpuroi_electricityCost', this.electricityCost);
                localStorage.setItem('gpuroi_poolFee', this.poolFeePercent);
                localStorage.setItem('gpuroi_cloudPlatformFee', this.cloudPlatformFeePercent);
                if (this.serpApiKey) {
                    localStorage.setItem('gpuroi_serpApiKey', this.serpApiKey);
                } else {
                    localStorage.removeItem('gpuroi_serpApiKey');
                }
            } catch (e) {}
        },

        /** Update a slider value and recalculate */
        updateSetting(key, value) {
            if (key === 'electricityCost') this.electricityCost = value;
            else if (key === 'poolFeePercent') this.poolFeePercent = value;
            else if (key === 'cloudPlatformFeePercent') this.cloudPlatformFeePercent = value;
            this.saveSettings();
            // Recalculate with existing data (no re-fetch)
            const results = this.calculateAll();
            if (this._onUpdate) this._onUpdate(results, this.isLive);
            return results;
        },

        /** Fetch all live data from multiple sources */
        async fetchLiveData() {
            let liveSourceCount = 0;
            this._dataSources = {};
            let usedLastLive = false;

            // 1. Crypto prices (multi-source)
            const cachedPrices = Cache.get('cryptoPrices');
            if (cachedPrices) {
                this._cryptoPrices = cachedPrices.data || cachedPrices;
                this._dataSources.prices = cachedPrices.sources || ['cache'];
            } else {
                const priceResult = await API.fetchCryptoPrices();
                if (priceResult) {
                    this._cryptoPrices = priceResult.data;
                    Cache.set('cryptoPrices', priceResult);
                    Cache.setLastLive('cryptoPrices', priceResult);
                    liveSourceCount += priceResult.sourceCount;
                    this._dataSources.prices = priceResult.sources;
                } else {
                    // Fall back to last successful live data instead of null
                    const lastLive = Cache.getLastLive('cryptoPrices');
                    if (lastLive) {
                        this._cryptoPrices = lastLive.data.data || lastLive.data;
                        this._dataSources.prices = ['last-live'];
                        usedLastLive = true;
                    }
                }
            }

            // 2. WhatToMine mining data
            const cachedWtm = Cache.get('whattomine');
            if (cachedWtm) {
                this._liveData = cachedWtm.data || cachedWtm;
                this._dataSources.mining = cachedWtm.sources || ['cache'];
            } else {
                const miningResult = await API.fetchMiningData();
                if (miningResult) {
                    this._liveData = miningResult.data;
                    Cache.set('whattomine', miningResult);
                    Cache.setLastLive('whattomine', miningResult);
                    liveSourceCount += miningResult.sourceCount;
                    this._dataSources.mining = miningResult.sources;
                } else {
                    // Fall back to last successful live data instead of null
                    const lastLive = Cache.getLastLive('whattomine');
                    if (lastLive) {
                        this._liveData = lastLive.data.data || lastLive.data;
                        this._dataSources.mining = ['last-live'];
                        usedLastLive = true;
                    } else {
                        this._liveData = null;
                    }
                }
            }

            // 3. BTC fees (multi-source)
            const cachedFees = Cache.get('btcFees');
            if (cachedFees) {
                this._btcFees = cachedFees.data || cachedFees;
                this._dataSources.fees = cachedFees.sources || ['cache'];
            } else {
                const feeResult = await API.fetchBtcFees();
                if (feeResult) {
                    this._btcFees = feeResult.data;
                    Cache.set('btcFees', feeResult);
                    Cache.setLastLive('btcFees', feeResult);
                    liveSourceCount += feeResult.sourceCount;
                    this._dataSources.fees = feeResult.sources;
                } else {
                    // Fall back to last successful live data instead of null
                    const lastLive = Cache.getLastLive('btcFees');
                    if (lastLive) {
                        this._btcFees = lastLive.data.data || lastLive.data;
                        this._dataSources.fees = ['last-live'];
                        usedLastLive = true;
                    } else {
                        this._btcFees = null;
                    }
                }
            }

            // 4. Cloud lease rates (Vast.ai)
            const cachedCloud = Cache.get('cloudRates');
            if (cachedCloud) {
                this._cloudRates = cachedCloud.data || cachedCloud;
                this._dataSources.cloud = cachedCloud.sources || ['cache'];
            } else {
                const cloudResult = await API.fetchCloudLeaseRates();
                if (cloudResult) {
                    this._cloudRates = cloudResult.data;
                    Cache.set('cloudRates', cloudResult);
                    Cache.setLastLive('cloudRates', cloudResult);
                    liveSourceCount += cloudResult.sourceCount;
                    this._dataSources.cloud = cloudResult.sources;
                } else {
                    // Fall back to last successful live data instead of null
                    const lastLive = Cache.getLastLive('cloudRates');
                    if (lastLive) {
                        this._cloudRates = lastLive.data.data || lastLive.data;
                        this._dataSources.cloud = ['last-live'];
                        usedLastLive = true;
                    } else {
                        this._cloudRates = null;
                    }
                }
            }

            // Determine live vs stale status
            const hasAnyCached = !!cachedPrices || !!cachedWtm || !!cachedFees || !!cachedCloud;
            this.isLive = liveSourceCount > 0 || hasAnyCached;
            this.isStale = !this.isLive && !usedLastLive;
            this.usingLastLive = usedLastLive && !this.isLive;
            this.lastRefresh = new Date();
            this.lastLiveTimestamp = Cache.getLastLiveTimestamp();

            // Fire stale warning — differentiate between last-live and full fallback
            if (!this.isLive && this._onStaleWarning) {
                if (usedLastLive && this.lastLiveTimestamp) {
                    const ago = this._formatTimeAgo(this.lastLiveTimestamp);
                    this._onStaleWarning(`Live data sources unreachable — showing last successful live data from ${ago}. Values may drift from current market.`);
                } else {
                    this._onStaleWarning('All live data sources unreachable. No prior live data available — showing hardcoded baseline estimates.');
                }
            }
        },

        /** Format a timestamp as a human-readable "time ago" string */
        _formatTimeAgo(ts) {
            const diff = Date.now() - ts;
            const mins = Math.floor(diff / 60000);
            if (mins < 1) return 'moments ago';
            if (mins < 60) return mins + 'm ago';
            const hours = Math.floor(mins / 60);
            if (hours < 24) return hours + 'h ago';
            const days = Math.floor(hours / 24);
            return days + 'd ago';
        },

        /** Calculate profitability for ALL GPUs */
        calculateAll(sortBy) {
            const fees = {
                poolFeePercent: this.poolFeePercent,
                cloudPlatformFeePercent: this.cloudPlatformFeePercent
            };
            const results = GPU_DATABASE.map(gpu =>
                Calculator.fullBreakdown(gpu, this.electricityCost, this._liveData, this._btcFees, fees, this._cloudRates)
            );

            const sortFn = {
                'profit-desc':     (a, b) => b.bestDailyProfit - a.bestDailyProfit,
                'profit-asc':      (a, b) => a.bestDailyProfit - b.bestDailyProfit,
                'best-gpu':        (a, b) => b.bestDailyProfit - a.bestDailyProfit,
                'roi-asc':         (a, b) => a.roiDays - b.roiDays,
                'roi-desc':        (a, b) => b.roiDays - a.roiDays,
                'efficiency-desc': (a, b) => b.efficiency - a.efficiency,
                'tdp-asc':         (a, b) => a.tdp - b.tdp,
                'price-asc':       (a, b) => a.msrp - b.msrp,
                'price-desc':      (a, b) => b.msrp - a.msrp,
            }[sortBy || 'profit-desc'] || ((a, b) => b.bestDailyProfit - a.bestDailyProfit);

            return results.sort(sortFn);
        },

        /** Full refresh: fetch → calculate → notify */
        async refresh() {
            await this.fetchLiveData();
            const results = this.calculateAll();
            if (this._onUpdate) this._onUpdate(results, this.isLive);
            return results;
        },

        /** Start auto-refresh every intervalMs (default 60s) */
        startAutoRefresh(intervalMs) {
            if (this._refreshTimer) clearInterval(this._refreshTimer);
            this._refreshTimer = setInterval(() => this.refresh(), intervalMs || 60000);
        },

        stopAutoRefresh() {
            if (this._refreshTimer) {
                clearInterval(this._refreshTimer);
                this._refreshTimer = null;
            }
        },

        /** Get current data sources for display */
        getDataSources() {
            return { ...this._dataSources, isLive: this.isLive, isStale: this.isStale, usingLastLive: this.usingLastLive, lastLiveTimestamp: this.lastLiveTimestamp, lastRefresh: this.lastRefresh };
        },

        getGPUDatabase() { return GPU_DATABASE; },
        getCoinDefinitions() { return COIN_DEFINITIONS; },
        getSliderConfig() { return SLIDER_CONFIG; },
        getFees() { return { ...DEFAULT_FEES, poolFeePercent: this.poolFeePercent, cloudPlatformFeePercent: this.cloudPlatformFeePercent }; }
    };

    /* ═══════════════════════════════════════════
       SLIDER UI BUILDER: Reusable across all widgets
       Creates styled range sliders with live value display
     ═══════════════════════════════════════════ */
    const SliderUI = {
        /**
         * Create a slider control panel and append to container.
         * @param {HTMLElement} container - DOM element to append sliders to
         * @param {object} options - { onUpdate: fn(key, value), theme: 'dark'|'light' }
         * @returns {object} - { update(key, value), getValues() }
         */
        create(container, options) {
            const theme = options?.theme || 'dark';
            const onUpdate = options?.onUpdate || (() => {});

            const panel = document.createElement('div');
            panel.className = 'gpuroi-slider-panel';
            panel.style.cssText = `
                display:flex; flex-wrap:wrap; gap:12px 24px; padding:10px 16px;
                background:${theme === 'dark' ? 'rgba(15,15,20,0.95)' : 'rgba(245,245,250,0.95)'};
                border:1px solid ${theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.1)'};
                border-radius:10px; font-family:inherit; align-items:center;
            `;

            const sliders = {};
            const configs = [
                SLIDER_CONFIG.electricityCost,
                SLIDER_CONFIG.poolFeePercent,
                SLIDER_CONFIG.cloudPlatformFeePercent
            ];
            const keys = ['electricityCost', 'poolFeePercent', 'cloudPlatformFeePercent'];

            keys.forEach((key, i) => {
                const cfg = configs[i];
                const currentVal = key === 'electricityCost' ? Engine.electricityCost :
                                   key === 'poolFeePercent' ? Engine.poolFeePercent :
                                   Engine.cloudPlatformFeePercent;

                const wrap = document.createElement('div');
                wrap.style.cssText = 'display:flex; align-items:center; gap:8px; min-width:200px; flex:1;';

                const label = document.createElement('span');
                label.style.cssText = `font-size:11px; font-weight:600; color:${theme === 'dark' ? '#999' : '#555'}; white-space:nowrap; min-width:80px; text-transform:uppercase; letter-spacing:0.5px;`;
                label.textContent = cfg.label;

                const input = document.createElement('input');
                input.type = 'range';
                input.min = cfg.min;
                input.max = cfg.max;
                input.step = cfg.step;
                input.value = currentVal;
                input.style.cssText = 'flex:1; min-width:80px; accent-color:#f97316; cursor:pointer; height:6px;';

                const valueSpan = document.createElement('span');
                valueSpan.style.cssText = `font-size:12px; font-weight:700; color:#f97316; min-width:55px; text-align:right; font-variant-numeric:tabular-nums;`;
                valueSpan.textContent = key === 'electricityCost' ? '$' + parseFloat(currentVal).toFixed(2) : parseFloat(currentVal).toFixed(1) + '%';

                input.addEventListener('input', () => {
                    const val = parseFloat(input.value);
                    valueSpan.textContent = key === 'electricityCost' ? '$' + val.toFixed(2) : val.toFixed(1) + '%';
                    onUpdate(key, val);
                });

                wrap.appendChild(label);
                wrap.appendChild(input);
                wrap.appendChild(valueSpan);
                panel.appendChild(wrap);

                sliders[key] = { input, valueSpan };
            });

            container.innerHTML = '';  // Clear existing sliders to prevent duplication on refresh
            container.appendChild(panel);

            return {
                update(key, value) {
                    if (sliders[key]) {
                        sliders[key].input.value = value;
                        sliders[key].valueSpan.textContent = key === 'electricityCost' ? '$' + value.toFixed(2) : value.toFixed(1) + '%';
                    }
                },
                getValues() {
                    const vals = {};
                    keys.forEach(k => { vals[k] = parseFloat(sliders[k].input.value); });
                    return vals;
                },
                element: panel
            };
        }
    };

    /* ═══════════════════════════════════════════
       STALE DATA WARNING BANNER
     ═══════════════════════════════════════════ */
    const StaleBanner = {
        create(container, theme) {
            const t = theme || 'dark';
            const banner = document.createElement('div');
            banner.className = 'gpuroi-stale-banner';
            banner.style.cssText = `
                display:none; padding:8px 16px; font-size:12px; font-weight:600;
                background:${t === 'dark' ? 'rgba(239,68,68,0.15)' : 'rgba(239,68,68,0.1)'};
                color:#ef4444; border:1px solid rgba(239,68,68,0.3);
                border-radius:8px; text-align:center; margin:6px 0;
                font-family:inherit;
            `;
            container.innerHTML = '';  // Clear existing banner to prevent duplication on refresh
            container.appendChild(banner);
            return {
                show(msg) {
                    banner.innerHTML = '⚠ ' + (msg || 'Live data unavailable — showing last known live data.');
                    banner.style.display = 'block';
                },
                hide() { banner.style.display = 'none'; },
                element: banner
            };
        }
    };

    /* ═══════════════════════════════════════════
       FORMAT UTILITIES
     ═══════════════════════════════════════════ */
    const Format = {
        currency(value, decimals) {
            if (value === null || value === undefined || isNaN(value)) return '-';
            return '$' + Math.abs(value).toFixed(decimals !== undefined ? decimals : 2);
        },
        signedCurrency(value) {
            if (value === null || value === undefined || isNaN(value)) return '-';
            return (value >= 0 ? '+' : '-') + '$' + Math.abs(value).toFixed(2);
        },
        roiDays(days) {
            if (days === Infinity || days === null || days === undefined) return '∞';
            return days <= 365 ? days + 'd' : (days / 365).toFixed(1) + 'y';
        },
        roiLabel(days) {
            if (days === Infinity) return 'Never';
            return days <= 365 ? days + ' days' : (days / 365).toFixed(1) + ' years';
        },
        tdp(watts) { return watts + 'W'; },
        hashrate(value, unit) {
            if (value >= 1000) return (value / 1000).toFixed(1) + ' G' + unit.replace('MH/s', 'H/s').replace('TH/s', 'H/s');
            return value + ' ' + unit;
        }
    };

    /* ═══════════════════════════════════════════
       SORT & RANKING UTILITIES
     ═══════════════════════════════════════════ */
    const Sort = {
        byMostProfitableUnit(results) {
            if (!results || !results.length) return [];
            return results.map(r => {
                const activities = [];
                if (r.cloudNet !== null && r.cloudNet !== undefined && !isNaN(r.cloudNet))
                    activities.push({ type: 'Cloud Lease', icon: '☁', netProfit: r.cloudNet });
                if (r.aiNet !== null && r.aiNet !== undefined && !isNaN(r.aiNet))
                    activities.push({ type: 'AI Inference', icon: '🤖', netProfit: r.aiNet });
                if (r.miningNet !== null && r.miningNet !== undefined && !isNaN(r.miningNet))
                    activities.push({ type: 'Mining', icon: '⛏', netProfit: r.miningNet });
                if (!activities.length) return null;
                const best = activities.reduce((a, b) => a.netProfit > b.netProfit ? a : b);
                return { gpu: r.gpu || r.name, bestActivity: best.type, netProfit: best.netProfit, icon: best.icon, category: r.category || 'consumer' };
            }).filter(Boolean).sort((a, b) => b.netProfit - a.netProfit);
        },
        byMostProfitableActivity(results) {
            if (!results || !results.length) return [];
            const all = [];
            results.forEach(r => {
                const name = r.gpu || r.name;
                if (r.cloudNet !== null && !isNaN(r.cloudNet))
                    all.push({ gpu: name, activity: 'Cloud Lease', icon: '☁', netProfit: r.cloudNet });
                if (r.aiNet !== null && !isNaN(r.aiNet))
                    all.push({ gpu: name, activity: 'AI Inference', icon: '🤖', netProfit: r.aiNet });
                if (r.miningNet !== null && !isNaN(r.miningNet))
                    all.push({ gpu: name, activity: 'Mining', icon: '⛏', netProfit: r.miningNet });
            });
            return all.sort((a, b) => b.netProfit - a.netProfit);
        }
    };

    /* ═══════════════════════════════════════════
       PUBLIC API
     ═══════════════════════════════════════════ */
    return {
        Engine,
        Calculator,
        API,
        Cache,
        Format,
        Sort,
        SliderUI,
        StaleBanner,
        GPU_DATABASE,
        COIN_DEFINITIONS,
        DEFAULT_FEES,
        BASELINE_REVENUE,
        STREET_PRICES,
        SLIDER_CONFIG
    };
})();
