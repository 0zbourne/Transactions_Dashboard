/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import Papa from 'papaparse';
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
  Legend,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
} from 'chart.js';
import { Doughnut, Bar } from 'react-chartjs-2';
import { 
  Upload, 
  Plus, 
  BarChart3, 
  PieChart, 
  Table as TableIcon, 
  Search, 
  TrendingDown, 
  TrendingUp, 
  Wallet, 
  RefreshCcw,
  Trash2,
  AlertCircle,
  Calendar,
  ChevronUp,
  ChevronDown,
  Filter,
  CloudOff,
  Info,
  X
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// --- Utility ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

ChartJS.register(
  ArcElement,
  Tooltip,
  Legend,
  CategoryScale,
  LinearScale,
  BarElement,
  Title
);

// --- Types ---
interface Transaction {
  id: string;
  date: string; // DD/MM/YYYY
  description: string;
  amount: number;
  category: string;
  bank: 'Barclaycard' | 'Amex' | 'Starling';
  uploadLogIds?: string[];
}

interface UploadLog {
  id: string;
  bank: string;
  fileName: string;
  transactionCount: number;
  uploadedAt: any;
  periodStart?: string;
  periodEnd?: string;
  uid: string;
}

interface Subscription {
  merchant: string;
  frequency: string;
  avgAmount: number;
  annualCost: number;
  count: number;
}

// --- Constants ---
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  'Income': ['salary', 'wage', 'payroll', 'employer', 'dividend', 'interest', 'inkorp', 'global shares', 'understan re ltd', 'pay'],
  'Savings & Investments': ['trading 212', 't212', 'vanguard', 'isa', 'investment', 'savings', 'pension', 'crypto', 'coinbase', 'binance'],
  'Transfer': ['direct debit', 'payment received', 'amex', 'american express', 'barclaycard', 'credit card', 'transfer', 'pot', 'space', 'to starling', 'from starling'],
  'Groceries': ['tesco', 'sainsbury', 'asda', 'lidl', 'aldi', 'co-op', 'coop', '7 11', 'waitrose', 'marks & spencer', 'm&s'],
  'Transport': ['uber', 'bolt', 'tfl', 'grab', 'fuel', 'petrol', 'trainline', 'eurostar', 'shell', 'bp'],
  'Eating Out': ['wetherspoon', 'nandos', 'starbucks', 'costa', 'mcdonalds', 'subway', 'restaurant', 'bar', 'pub', 'deliveroo', 'just eat', 'uber eats'],
  'Shopping': ['amazon', 'amzn', 'argos', 'boots', 'next', 'zara', 'h&m', 'ebay', 'apple'],
  'Entertainment': ['netflix', 'spotify', 'disney', 'cinema', 'steam', 'playstation', 'xbox'],
  'Rent': ['rent', 'letting', 'lets', 'estate agent', 'property management', 'landlord', 'residential'],
  'Bills': ['smarty', 'virgin media', 'bt ', 'water', 'electric', 'gas', 'council', 'insurance', 'mortgage'],
  'Subscriptions': ['proton', 'porkbun', 'google play', 'icloud', 'adobe', 'microsoft', 'chatgpt', 'openai']
};

const BANK_FORMATS = ['Barclaycard', 'Amex', 'Starling'] as const;
type BankType = typeof BANK_FORMATS[number];

// --- Logic Functions ---

/**
 * Generates a unique fingerprint for a transaction to prevent duplicates.
 * Includes an index to handle multiple identical transactions on the same day.
 */
function generateFingerprint(t: Omit<Transaction, 'id'>, index: number = 0): string {
  const data = `${t.date}|${t.description}|${t.amount}|${t.bank}|${index}`;
  // Simple hash for fingerprinting
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

function autoCategorize(description: string, amount: number, bankCategory: string = 'Uncategorized'): string {
  const desc = description.toLowerCase();
  
  // Special handling for Trading 212 as requested (for spending/deposits)
  if (desc.includes('trading 212') || desc.includes('t212')) {
    return 'Savings & Investments';
  }

  // If it's a positive amount (credit)
  if (amount > 0) {
    // Check for specific income sources first (high confidence)
    const highConfidenceIncome = ['wetherspoon', 'j d wetherspoon', 'inkorp', 'global shares', 'understan re ltd', 'trading 212', 't212'];
    if (highConfidenceIncome.some(kw => desc.includes(kw))) {
      return 'Income';
    }

    // Check if it's a refund for a spending category
    // This is high priority to ensure refunds offset the correct spending category
    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      if (category === 'Income' || category === 'Transfer' || category === 'Savings & Investments') continue;
      if (keywords.some(kw => desc.includes(kw.toLowerCase()))) {
        return category; // It's a refund in a spending category
      }
    }

    // Check for standard income keywords (salary, etc.)
    const incomeKeywords = CATEGORY_KEYWORDS['Income'];
    if (incomeKeywords.some(kw => {
      if (kw === 'pay') {
        return desc.split(/\s+/).includes('pay');
      }
      return desc.includes(kw.toLowerCase());
    })) {
      return 'Income';
    }

    // Fallback for generic refunds/credits that didn't match a spending category
    const genericRefundKeywords = ['refund', 'dispute', 'disputed charge', 'credit adjustment', 'credit', 'cashback'];
    if (genericRefundKeywords.some(kw => desc.includes(kw))) {
      return 'Refunds';
    }

    // Check for transfer keywords
    const transferKeywords = CATEGORY_KEYWORDS['Transfer'];
    if (transferKeywords.some(kw => desc.includes(kw.toLowerCase()))) {
      return 'Transfer';
    }

    // Default for positive amounts that aren't clearly income: Refunds
    return 'Refunds';
  }

  // For negative amounts (spending)
  
  // Rent detection via address patterns (high priority for large recurring costs)
  const addressKeywords = ['flat', 'apartment', 'house', 'street', 'road', 'avenue', 'lane', 'drive', 'court', 'gardens', 'square', 'terrace', 'close', 'mews', 'place', 'hill', 'grove', 'park', 'view', 'crescent', 'walk'];
  const addressRegex = new RegExp(`\\b(${addressKeywords.join('|')})\\b`, 'i');
  // Rent is typically a significant amount
  if (addressRegex.test(desc) && Math.abs(amount) > 200) {
    return 'Rent';
  }

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    // Skip Income category for spending unless it's a known keyword (like a refund, but we handled credits above)
    if (category === 'Income') continue;
    
    if (keywords.some(kw => desc.includes(kw.toLowerCase()))) {
      return category;
    }
  }

  // If no keyword match, use bank category if available
  return bankCategory !== 'Uncategorized' ? bankCategory : 'Uncategorized';
}

function detectBank(data: string[][]): BankType | null {
  if (data.length === 0) return null;
  
  const firstRow = data[0].map(h => h.toLowerCase());
  
  // Starling detection: Date, Counterparty, Reference, Type, Amount (GBP), Balance (GBP), Category, Note
  if (firstRow.includes('counterparty') && firstRow.includes('amount (gbp)')) {
    return 'Starling';
  }
  
  // Amex detection: Date, Description, Amount, Extended Details, ...
  if (firstRow.includes('extended details') && firstRow.includes('description')) {
    return 'Amex';
  }
  
  // Barclaycard detection: Date, Description, Category, Amount
  const allText = data.slice(0, 5).flat().join(' ').toLowerCase();
  if (allText.includes('barclaycard') || allText.includes('account number') || allText.includes('card number')) {
      return 'Barclaycard';
  }

  // Fallback: Check column counts
  if (data[0].length >= 11) return 'Amex';
  if (data[0].length >= 8) return 'Starling';
  if (data[0].length >= 7) return 'Barclaycard';

  return null;
}

function normalizeDate(dateStr: string, bank: BankType): string {
  if (bank === 'Barclaycard') {
    // Format: 23 Feb 26
    const parts = dateStr.trim().split(' ');
    if (parts.length === 3) {
      const day = parts[0].padStart(2, '0');
      const monthMap: Record<string, string> = {
        'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04', 'May': '05', 'Jun': '06',
        'Jul': '07', 'Aug': '08', 'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
      };
      const month = monthMap[parts[1]] || '01';
      const year = '20' + parts[2];
      return `${day}/${month}/${year}`;
    }
  }
  // Amex and Starling are already DD/MM/YYYY or similar
  return dateStr;
}

function normalizeAmount(amountStr: string, bank: BankType): number {
  let val = parseFloat(amountStr.replace(/,/g, '').replace(/[£$]/g, ''));
  if (isNaN(val)) return 0;
  
  if (bank === 'Barclaycard' || bank === 'Amex') {
    // In these formats, charges are typically positive and credits are negative.
    // We want charges to be negative (spending) and credits to be positive (income/refund).
    return -val;
  }
  // Starling is already correct
  return val;
}

function parseDate(dateStr: string): Date {
  const [d, m, y] = dateStr.split('/').map(Number);
  return new Date(y, m - 1, d);
}

function detectSubscriptions(transactions: Transaction[]): Subscription[] {
  const groups: Record<string, Transaction[]> = {};
  
  transactions.forEach(t => {
    if (t.amount >= 0) return; // Only spending
    if (t.category === 'Transfer') return; // Skip transfers
    
    // Normalize description: lowercase, remove numbers and special chars
    const normalizedDesc = t.description
      .toLowerCase()
      .replace(/[0-9]/g, '')
      .replace(/[*#]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
      
    if (!groups[normalizedDesc]) groups[normalizedDesc] = [];
    groups[normalizedDesc].push(t);
  });
  
  const subs: Subscription[] = [];
  
  Object.entries(groups).forEach(([desc, txs]) => {
    if (txs.length < 2) return;
    
    // Sort by date
    const sortedTxs = [...txs].sort((a, b) => {
      const dateA = parseDate(a.date).getTime();
      const dateB = parseDate(b.date).getTime();
      return dateA - dateB;
    });

    // Calculate intervals (days between)
    const intervals: number[] = [];
    for (let i = 1; i < sortedTxs.length; i++) {
      const d1 = parseDate(sortedTxs[i-1].date);
      const d2 = parseDate(sortedTxs[i].date);
      const diffDays = Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
      intervals.push(diffDays);
    }

    // Check if amounts are within 15% tolerance
    const avgAmount = txs.reduce((sum, t) => sum + t.amount, 0) / txs.length;
    const isAmountConsistent = txs.every(t => Math.abs(t.amount - avgAmount) <= Math.abs(avgAmount * 0.15));

    if (!isAmountConsistent) return;

    // Detect frequency based on intervals
    let frequency = '';
    if (intervals.length === 1) {
      const days = intervals[0];
      // For only 2 transactions, we must be very close to a standard period
      if (days >= 27 && days <= 33) frequency = 'Monthly';
      else if (days >= 6 && days <= 8) frequency = 'Weekly';
      else if (days >= 350 && days <= 380) frequency = 'Yearly';
    } else {
      // Multiple intervals - check median
      const sortedIntervals = [...intervals].sort((a, b) => a - b);
      const median = sortedIntervals[Math.floor(sortedIntervals.length / 2)];
      
      if (median >= 25 && median <= 35) frequency = 'Monthly';
      else if (median >= 6 && median <= 8) frequency = 'Weekly';
      else if (median >= 350 && median <= 380) frequency = 'Yearly';
      
      // Check if intervals are somewhat consistent (at least 70% of intervals are close to median)
      const closeToMedianCount = intervals.filter(d => Math.abs(d - median) <= 5).length;
      if (closeToMedianCount / intervals.length < 0.7) {
         frequency = ''; 
      }
    }

    // Final check: if it's a common shopping merchant but intervals are not strictly monthly, skip
    const isShopping = ['amazon', 'tesco', 'sainsbury', 'asda', 'lidl', 'aldi', 'ebay'].some(m => desc.includes(m));
    if (isShopping && frequency === 'Monthly' && intervals.some(d => d < 20)) {
      frequency = '';
    }

    if (frequency) {
      subs.push({
        merchant: txs[0].description,
        frequency,
        avgAmount: Math.abs(avgAmount),
        annualCost: Math.abs(avgAmount) * (frequency === 'Monthly' ? 12 : frequency === 'Weekly' ? 52 : 1),
        count: txs.length
      });
    }
  });
  
  return subs.sort((a, b) => b.annualCost - a.annualCost);
}

// --- Components ---

export default function App() {
  const [allTransactions, setAllTransactions] = useState<Transaction[]>([]);
  const [uploadLogs, setUploadLogs] = useState<UploadLog[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedBankFilter, setSelectedBankFilter] = useState<string>('all');
  const [hideTransfers, setHideTransfers] = useState(true);
  const [sortConfig, setSortConfig] = useState<{ key: keyof Transaction, direction: 'asc' | 'desc' }>({ key: 'date', direction: 'desc' });
  const [showHistory, setShowHistory] = useState(false);
  const [modal, setModal] = useState<{
    show: boolean;
    title: string;
    message: string;
    onConfirm?: () => void;
    type: 'confirm' | 'alert';
  }>({ show: false, title: '', message: '', type: 'alert' });

  const showAlert = (title: string, message: string) => {
    setModal({ show: true, title, message, type: 'alert' });
  };

  const showConfirm = (title: string, message: string, onConfirm: () => void) => {
    setModal({ show: true, title, message, onConfirm, type: 'confirm' });
  };

  const categories = useMemo(() => {
    const cats = new Set<string>();
    allTransactions.forEach(t => cats.add(t.category));
    return Array.from(cats).sort();
  }, [allTransactions]);

  const banks = useMemo(() => {
    const bks = new Set<string>();
    allTransactions.forEach(t => bks.add(t.bank));
    return Array.from(bks).sort();
  }, [allTransactions]);

  // Local Storage Sync
  useEffect(() => {
    const savedTxs = localStorage.getItem('transactions');
    const savedLogs = localStorage.getItem('upload_logs');
    
    if (savedTxs) {
      try {
        setAllTransactions(JSON.parse(savedTxs));
      } catch (e) {
        console.error("Failed to parse saved transactions", e);
      }
    }
    
    if (savedLogs) {
      try {
        setUploadLogs(JSON.parse(savedLogs));
      } catch (e) {
        console.error("Failed to parse saved upload logs", e);
      }
    }
  }, []);

  // Save to Local Storage whenever data changes
  useEffect(() => {
    localStorage.setItem('transactions', JSON.stringify(allTransactions));
  }, [allTransactions]);

  useEffect(() => {
    localStorage.setItem('upload_logs', JSON.stringify(uploadLogs));
  }, [uploadLogs]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsAnalyzing(true);
    Papa.parse(file, {
      complete: (results) => {
        const data = results.data as string[][];
        const parsedTxs: Omit<Transaction, 'id'>[] = [];
        
        const bank = detectBank(data);
        if (!bank) {
          setIsAnalyzing(false);
          showAlert("Unknown Format", "Could not automatically detect the bank format. Please ensure you are uploading a valid CSV from Starling, Amex, or Barclaycard.");
          return;
        }

        if (bank === 'Barclaycard') {
          data.forEach((row) => {
            if (row.length < 7 || !row[0]) return;
            const amount = normalizeAmount(row[6], 'Barclaycard');
            if (isNaN(amount) || (amount === 0 && row[0].toLowerCase().includes('date'))) return; // Skip headers
            
            const rawDesc = row[1];
            const rawCat = row[4] || 'Uncategorized';
            parsedTxs.push({
              date: normalizeDate(row[0], 'Barclaycard'),
              description: rawDesc,
              amount: amount,
              category: autoCategorize(rawDesc, amount, rawCat),
              bank: 'Barclaycard'
            });
          });
        } else if (bank === 'Amex') {
          data.slice(1).forEach((row) => {
            if (row.length < 11 || !row[0]) return;
            const rawDesc = row[1];
            const rawCat = row[10] ? row[10].split('-')[0].trim() : 'Uncategorized';
            const amount = normalizeAmount(row[2], 'Amex');
            parsedTxs.push({
              date: normalizeDate(row[0], 'Amex'),
              description: rawDesc,
              amount: amount,
              category: autoCategorize(rawDesc, amount, rawCat),
              bank: 'Amex'
            });
          });
        } else if (bank === 'Starling') {
          data.slice(1).forEach((row) => {
            if (row.length < 8 || !row[0]) return;
            const counterparty = row[1] || '';
            const reference = row[2] || '';
            const fullDesc = `${counterparty} ${reference}`.trim();
            const rawCat = row[6] ? row[6].replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : 'Uncategorized';
            const amount = normalizeAmount(row[4], 'Starling');
            parsedTxs.push({
              date: normalizeDate(row[0], 'Starling'),
              description: fullDesc,
              amount: amount,
              category: autoCategorize(fullDesc, amount, rawCat),
              bank: 'Starling'
            });
          });
        }

        // Detect period
        let minDate = Infinity;
        let maxDate = -Infinity;
        parsedTxs.forEach(tx => {
          const [d, m, y] = tx.date.split('/').map(Number);
          const time = new Date(y, m - 1, d).getTime();
          if (time < minDate) minDate = time;
          if (time > maxDate) maxDate = time;
        });

        const periodStart = minDate !== Infinity ? new Date(minDate).toISOString() : null;
        const periodEnd = maxDate !== -Infinity ? new Date(maxDate).toISOString() : null;

        const logId = `log_${Date.now()}`;

        const processUpload = () => {
          const occurrenceMap: Record<string, number> = {};
          
          setAllTransactions(prev => {
            const existingIds = new Set(prev.map(t => t.id));
            const newTransactions: Transaction[] = [];
            
            parsedTxs.forEach(tx => {
              const key = `${tx.date}|${tx.description}|${tx.amount}|${tx.bank}`;
              const occurrence = occurrenceMap[key] || 0;
              occurrenceMap[key] = occurrence + 1;
              
              const fingerprint = generateFingerprint(tx, occurrence);
              if (!existingIds.has(fingerprint)) {
                newTransactions.push({ 
                  ...tx, 
                  id: fingerprint,
                  uploadLogIds: [logId]
                });
              } else {
                // If it exists, we should ideally add the logId to it, but for local storage
                // we'll keep it simple and just skip.
              }
            });
            
            return [...prev, ...newTransactions];
          });

          setUploadLogs(prev => [
            {
              id: logId,
              bank: bank,
              fileName: file.name,
              transactionCount: parsedTxs.length,
              uploadedAt: new Date().toISOString(),
              periodStart: periodStart || undefined,
              periodEnd: periodEnd || undefined,
              uid: 'local'
            },
            ...prev
          ]);

          setIsAnalyzing(false);
          showAlert("Upload Complete", `Successfully added ${parsedTxs.length} transactions locally.`);
          e.target.value = '';
        };

        // Check for duplicate upload log
        const isDuplicateUpload = uploadLogs.some(log => 
          log.fileName === file.name && 
          log.transactionCount === parsedTxs.length &&
          log.periodStart === periodStart &&
          log.periodEnd === periodEnd
        );

        if (isDuplicateUpload) {
          showConfirm(
            "Duplicate Upload Detected",
            `It looks like you've already uploaded "${file.name}" for this period. Uploading it again won't create duplicate transactions, but it will add another entry to your upload history. Do you want to proceed?`,
            processUpload
          );
          return;
        }

        processUpload();
      },
      error: (err) => {
        console.error("CSV Parse Error", err);
        setIsAnalyzing(false);
        showAlert("Upload Error", "Failed to parse CSV file.");
      }
    });
  };

  const clearData = () => {
    showConfirm(
      "Clear All Data",
      "Are you sure you want to clear all transaction and history data? This action cannot be undone.",
      () => {
        setAllTransactions([]);
        setUploadLogs([]);
        localStorage.removeItem('transactions');
        localStorage.removeItem('upload_logs');
      }
    );
  };

  // --- Derived Data ---

  const dashboardPeriod = useMemo(() => {
    if (allTransactions.length === 0) return null;
    
    let maxTime = -Infinity;
    allTransactions.forEach(t => {
      const [d, m, y] = t.date.split('/').map(Number);
      const time = new Date(y, m - 1, d).getTime();
      if (time > maxTime) maxTime = time;
    });
    
    const latestDate = new Date(maxTime);
    const startDate = new Date(latestDate.getFullYear(), latestDate.getMonth() - 11, 1);
    
    return {
      startTime: startDate.getTime(),
      label: `${startDate.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })} - ${latestDate.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`
    };
  }, [allTransactions]);

  const filteredTransactions = useMemo(() => {
    let result = allTransactions;

    // 12-month window based on latest transaction
    if (dashboardPeriod) {
      result = result.filter(t => {
        const [d, m, y] = t.date.split('/').map(Number);
        return new Date(y, m - 1, d).getTime() >= dashboardPeriod.startTime;
      });
    }

    // Search filter
    result = result.filter(t => 
      t.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
      t.category.toLowerCase().includes(searchTerm.toLowerCase()) ||
      t.bank.toLowerCase().includes(searchTerm.toLowerCase())
    );

    // Category filter
    if (selectedCategory !== 'all') {
      result = result.filter(t => t.category === selectedCategory);
    }

    // Bank filter
    if (selectedBankFilter !== 'all') {
      result = result.filter(t => t.bank === selectedBankFilter);
    }

    // Hide transfers filter
    if (hideTransfers) {
      result = result.filter(t => t.category !== 'Transfer');
    }

    result.sort((a, b) => {
      let valA = a[sortConfig.key];
      let valB = b[sortConfig.key];

      if (sortConfig.key === 'date') {
        const [dA, mA, yA] = a.date.split('/').map(Number);
        const [dB, mB, yB] = b.date.split('/').map(Number);
        valA = new Date(yA, mA - 1, dA).getTime();
        valB = new Date(yB, mB - 1, dB).getTime();
      }

      if (typeof valA === 'string') valA = valA.toLowerCase();
      if (typeof valB === 'string') valB = valB.toLowerCase();

      if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
      if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });

    return result;
  }, [allTransactions, searchTerm, sortConfig, selectedCategory, selectedBankFilter, dashboardPeriod, hideTransfers]);

  const stats = useMemo(() => {
    // Use filtered transactions for stats (already restricted to 12 months)
    const nonTransferTransactions = filteredTransactions.filter(t => t.category !== 'Transfer');
    
    const totalExpenses = nonTransferTransactions
      .filter(t => t.category !== 'Income' && t.category !== 'Savings & Investments')
      .reduce((sum, t) => sum + t.amount, 0);
    
    const totalIncome = nonTransferTransactions
      .filter(t => t.category === 'Income')
      .reduce((sum, t) => sum + t.amount, 0);
    
    // Net Savings (Money sent to savings minus any withdrawals/dividends returned to bank)
    const savingsOut = nonTransferTransactions.filter(t => t.category === 'Savings & Investments' && t.amount < 0).reduce((sum, t) => sum + Math.abs(t.amount), 0);
    const savingsIn = nonTransferTransactions.filter(t => t.category === 'Savings & Investments' && t.amount > 0).reduce((sum, t) => sum + t.amount, 0);
    const totalSavings = savingsOut - savingsIn;
    
    // Count unique months in the filtered data to get accurate averages
    const monthsInData = new Set(filteredTransactions.map(t => {
      const [d, m, y] = t.date.split('/');
      return `${y}-${m}`;
    })).size || 1;

    // Monthly averages
    const monthlyIncome = totalIncome / monthsInData;
    const monthlySavings = totalSavings / monthsInData;
    const monthlySpent = Math.abs(totalExpenses) / monthsInData;
    const monthlyNet = (totalIncome + totalExpenses) / monthsInData;

    // Yearly totals (actual sum of filtered transactions in the 12-month window)
    const yearlyIncome = totalIncome;
    const yearlySavings = totalSavings;
    const savingsRate = yearlyIncome > 0 ? (yearlySavings / yearlyIncome) * 100 : 0;

    return {
      spent: monthlySpent,
      income: monthlyIncome,
      savings: monthlySavings,
      yearlyIncome,
      yearlySavings,
      savingsRate,
      net: monthlyNet,
      count: filteredTransactions.length,
      monthsCount: monthsInData
    };
  }, [filteredTransactions]);

  const categoryBreakdown = useMemo(() => {
    // Only include spending categories (exclude Income, Transfer, Savings & Investments)
    const nonTransferTransactions = filteredTransactions.filter(t => t.category !== 'Transfer');
    const expenses = nonTransferTransactions.filter(t => t.category !== 'Income' && t.category !== 'Savings & Investments');
    
    const breakdown: Record<string, number> = {};
    expenses.forEach(t => {
      // Amount is negative for spending, positive for refunds
      breakdown[t.category] = (breakdown[t.category] || 0) + t.amount;
    });

    const monthsInData = stats.monthsCount || 1;

    return Object.entries(breakdown)
      .map(([category, total]) => ({
        category,
        total: Math.abs(total),
        average: Math.abs(total) / monthsInData
      }))
      .filter(item => item.total > 0)
      .sort((a, b) => b.average - a.average);
  }, [filteredTransactions, stats.monthsCount]);

  const categoryChartData = useMemo(() => {
    // Use filtered transactions for chart to respect month filter
    const spending = filteredTransactions.filter(t => t.amount < 0 && t.category !== 'Transfer');
    const catTotals: Record<string, number> = {};
    spending.forEach(t => {
      catTotals[t.category] = (catTotals[t.category] || 0) + Math.abs(t.amount);
    });

    const sorted = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);
    const top8 = sorted.slice(0, 8);
    const others = sorted.slice(8).reduce((sum, item) => sum + item[1], 0);

    const labels = top8.map(i => i[0]);
    const data = top8.map(i => i[1]);
    if (others > 0) {
      labels.push('Other');
      data.push(others);
    }

    return {
      labels,
      datasets: [{
        data,
        backgroundColor: [
          '#f87171', '#fb923c', '#fbbf24', '#a3e635', 
          '#2dd4bf', '#38bdf8', '#818cf8', '#c084fc', '#94a3b8'
        ],
        borderWidth: 0,
      }]
    };
  }, [filteredTransactions]);

  const trendChartData = useMemo(() => {
    const monthTotals: Record<string, number> = {};
    allTransactions.forEach(t => {
      if (t.amount >= 0 || t.category === 'Transfer') return;
      const [d, m, y] = t.date.split('/');
      const key = `${y}-${m}`;
      monthTotals[key] = (monthTotals[key] || 0) + Math.abs(t.amount);
    });

    const sortedKeys = Object.keys(monthTotals).sort();
    const labels = sortedKeys.map(k => {
      const [y, m] = k.split('-');
      const date = new Date(parseInt(y), parseInt(m) - 1);
      return date.toLocaleString('default', { month: 'short', year: '2-digit' });
    });
    const data = sortedKeys.map(k => monthTotals[k]);

    return {
      labels,
      datasets: [{
        label: 'Monthly Spending',
        data,
        backgroundColor: '#6366f1',
        borderRadius: 4,
      }]
    };
  }, [allTransactions]);

  const subscriptions = useMemo(() => detectSubscriptions(allTransactions), [allTransactions]);

  const coverageStats = useMemo(() => {
    const daily: Record<string, Set<string>> = {
      'Barclaycard': new Set(),
      'Amex': new Set(),
      'Starling': new Set()
    };
    
    allTransactions.forEach(t => {
      if (daily[t.bank]) daily[t.bank].add(t.date);
    });

    const spans: Record<string, { start: number, end: number, id: string, fileName: string }[]> = {
      'Barclaycard': [],
      'Amex': [],
      'Starling': []
    };
    
    uploadLogs.forEach(log => {
      if (log.periodStart && log.periodEnd && spans[log.bank]) {
        spans[log.bank].push({
          start: new Date(log.periodStart).getTime(),
          end: new Date(log.periodEnd).getTime(),
          id: log.id,
          fileName: log.fileName
        });
      }
    });

    return { daily, spans };
  }, [allTransactions, uploadLogs]);

  const last12Months = useMemo(() => {
    const months = [];
    const now = new Date();
    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const y = d.getFullYear();
      const m = (d.getMonth() + 1).toString().padStart(2, '0');
      months.push(`${y}-${m}`);
    }
    return months;
  }, []);

  const handleDeleteLog = (logId: string) => {
    showConfirm(
      "Delete Upload Log",
      "Are you sure you want to delete this upload log? This will also delete all transactions associated with this statement.",
      () => {
        setAllTransactions(prev => prev.filter(t => !t.uploadLogIds?.includes(logId)));
        setUploadLogs(prev => prev.filter(log => log.id !== logId));
        showAlert("Log Deleted", "The upload log and its transactions have been removed.");
      }
    );
  };

  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(val);
  };

  const SortIcon = ({ column }: { column: keyof Transaction }) => {
    if (sortConfig.key !== column) return <ChevronUp size={14} className="opacity-0 group-hover:opacity-50" />;
    return sortConfig.direction === 'asc' ? <ChevronUp size={14} className="text-indigo-400" /> : <ChevronDown size={14} className="text-indigo-400" />;
  };

  const handleSort = (key: keyof Transaction) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
  };

  const isFiltered = searchTerm !== '' || selectedCategory !== 'all' || selectedBankFilter !== 'all';

  const clearFilters = () => {
    setSearchTerm('');
    setSelectedCategory('all');
    setSelectedBankFilter('all');
    setHideTransfers(true);
  };

  return (
    <div className="min-h-screen bg-[#121212] text-white font-sans p-4 md:p-8">
      {/* Breakdown Modal */}
      <AnimatePresence>
        {showBreakdown && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowBreakdown(false)}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-md bg-[#1e1e1e] border border-gray-800 rounded-2xl shadow-2xl overflow-hidden"
            >
              <div className="p-6 border-b border-gray-800 flex items-center justify-between">
                <div>
                  <h3 className="text-xl font-bold text-white">Monthly Breakdown</h3>
                  <p className="text-xs text-gray-500 mt-1">Avg. expenses by category ({stats.monthsCount} months)</p>
                </div>
                <button 
                  onClick={() => setShowBreakdown(false)}
                  className="p-2 hover:bg-gray-800 rounded-lg transition-colors text-gray-400 hover:text-white"
                >
                  <X size={20} />
                </button>
              </div>
              
              <div className="p-6 max-h-[60vh] overflow-y-auto custom-scrollbar">
                <div className="space-y-6">
                  {categoryBreakdown.map((item) => (
                    <div key={item.category} className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium text-gray-300">{item.category}</span>
                        <span className="font-bold text-white">{formatCurrency(item.average)}</span>
                      </div>
                      <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                        <motion.div 
                          initial={{ width: 0 }}
                          animate={{ width: `${(item.average / stats.spent) * 100}%` }}
                          transition={{ duration: 0.8, ease: "easeOut" }}
                          className="h-full bg-indigo-500"
                        />
                      </div>
                      <div className="flex justify-between text-[10px] text-gray-500">
                        <span>{((item.average / stats.spent) * 100).toFixed(1)}% of total</span>
                        <span>Total: {formatCurrency(item.total)}</span>
                      </div>
                    </div>
                  ))}
                  
                  {categoryBreakdown.length === 0 && (
                    <div className="text-center py-8">
                      <p className="text-gray-500">No spending data found for this period.</p>
                    </div>
                  )}
                </div>
              </div>
              
              <div className="p-6 bg-[#252525] border-t border-gray-800 flex items-center justify-between">
                <span className="text-sm font-medium text-gray-400">Total Avg. Monthly</span>
                <span className="text-lg font-bold text-red-400">{formatCurrency(stats.spent)}</span>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Modal */}
      {modal.show && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-[#1e1e1e] border border-gray-800 rounded-xl p-6 max-w-md w-full shadow-2xl animate-in fade-in zoom-in duration-200">
            <h3 className="text-xl font-bold text-white mb-2">{modal.title}</h3>
            <p className="text-gray-400 mb-6 leading-relaxed">{modal.message}</p>
            <div className="flex justify-end gap-3">
              {modal.type === 'confirm' && (
                <button 
                  onClick={() => setModal({ ...modal, show: false })}
                  className="px-5 py-2.5 bg-[#2a2a2a] text-gray-300 border border-gray-700 rounded-lg hover:bg-[#333] transition-colors"
                >
                  Cancel
                </button>
              )}
              <button 
                onClick={() => {
                  if (modal.onConfirm) modal.onConfirm();
                  setModal({ ...modal, show: false });
                }}
                className={`px-5 py-2.5 rounded-lg transition-colors font-medium ${
                  modal.type === 'confirm' 
                    ? 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg shadow-indigo-500/20' 
                    : 'bg-[#2a2a2a] text-gray-300 border border-gray-700 hover:bg-[#333]'
                }`}
              >
                {modal.type === 'confirm' ? 'Confirm' : 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="max-w-7xl mx-auto space-y-8">
        
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">1-Year Trailing Dashboard</h1>
            <div className="flex items-center gap-2 mt-1">
              <p className="text-gray-400">
                {dashboardPeriod ? `Analysis for ${dashboardPeriod.label}` : "Local-only view of your bank statements"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <input 
                type="file" 
                accept=".csv"
                onChange={handleFileUpload}
                className="hidden" 
                id="header-csv-upload"
              />
              <label 
                htmlFor="header-csv-upload"
                className={cn(
                  "flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg cursor-pointer hover:bg-indigo-700 transition-colors",
                  isAnalyzing && "opacity-50 cursor-not-allowed pointer-events-none"
                )}
              >
                <Upload size={18} />
                <span>{isAnalyzing ? "Analyzing..." : "Upload CSV"}</span>
              </label>
            </div>
            <button 
              onClick={() => setShowHistory(!showHistory)}
              className={cn(
                "flex items-center gap-2 px-4 py-2 border rounded-lg transition-colors",
                showHistory ? "bg-indigo-600 border-indigo-500 text-white" : "bg-[#2a2a2a] border-gray-700 text-gray-300 hover:bg-[#333]"
              )}
            >
              <RefreshCcw size={18} className={cn(showHistory && "animate-spin-once")} />
              <span>{showHistory ? "History" : "History"}</span>
            </button>
            <button 
              onClick={clearData}
              disabled={isAnalyzing}
              className={cn(
                "flex items-center gap-2 px-4 py-2 bg-red-900/20 text-red-400 border border-red-900/50 rounded-lg transition-colors",
                isAnalyzing ? "opacity-50 cursor-not-allowed" : "hover:bg-red-900/30"
              )}
            >
              <Trash2 size={18} />
              <span>{isAnalyzing ? "Processing..." : "Clear Data"}</span>
            </button>
          </div>
        </header>

        {/* Summary Cards */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div 
            className="bg-[#1e1e1e] border border-gray-800 p-6 rounded-xl space-y-2 cursor-pointer hover:border-indigo-500/50 transition-colors group"
            onClick={() => setShowBreakdown(true)}
          >
            <div className="flex items-center justify-between">
              <span className="text-gray-400 text-sm font-medium group-hover:text-indigo-300 transition-colors">Monthly Spending</span>
              <TrendingDown className="text-red-400" size={20} />
            </div>
            <p className="text-2xl font-bold text-red-400">{formatCurrency(stats.spent)}</p>
            <p className="text-[10px] text-gray-500">Living expenses (excl. savings)</p>
          </div>
          <div className="bg-[#1e1e1e] border border-gray-800 p-6 rounded-xl space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-gray-400 text-sm font-medium">Monthly Income</span>
              <TrendingUp className="text-green-400" size={20} />
            </div>
            <p className="text-2xl font-bold text-green-400">{formatCurrency(stats.income)}</p>
            <p className="text-[10px] text-gray-500">Avg. monthly income</p>
          </div>
          <div className="bg-[#1e1e1e] border border-gray-800 p-6 rounded-xl space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-gray-400 text-sm font-medium">Monthly Savings</span>
              <PieChart className="text-amber-400" size={20} />
            </div>
            <p className="text-2xl font-bold text-amber-400">{formatCurrency(stats.savings)}</p>
            <p className="text-[10px] text-gray-500">Avg. monthly savings/investments</p>
          </div>
          <div className="bg-[#1e1e1e] border border-gray-800 p-6 rounded-xl space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-gray-400 text-sm font-medium">Net Cash Flow</span>
              <Wallet className="text-indigo-400" size={20} />
            </div>
            <p className={cn("text-2xl font-bold", stats.net >= 0 ? "text-green-400" : "text-red-400")}>
              {formatCurrency(stats.net)}
            </p>
            <p className="text-[10px] text-gray-500">Income - Living Expenses</p>
          </div>
        </section>

        {/* Financial Health Section */}
        <section className="bg-[#1e1e1e] border border-gray-800 rounded-xl p-6 overflow-hidden relative group">
          <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:opacity-10 transition-opacity">
            <TrendingUp size={120} className="text-indigo-400" />
          </div>
          <div className="relative z-10">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <BarChart3 size={20} className="text-indigo-400" />
                <h2 className="text-xl font-bold">Financial Health Summary</h2>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-gray-500 bg-gray-800/50 px-3 py-1.5 rounded-lg border border-gray-700">
                <Info size={12} className="text-indigo-400" />
                <span>Internal transfers are excluded from spending to prevent overstatement.</span>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              <div className="space-y-1">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Total Income (Last 12m)</p>
                <p className="text-3xl font-bold text-white">{formatCurrency(stats.yearlyIncome)}</p>
                <p className="text-[10px] text-gray-400 mt-1">Actual total income in analysis period</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Total Savings (Last 12m)</p>
                <p className="text-3xl font-bold text-amber-400">{formatCurrency(stats.yearlySavings)}</p>
                <p className="text-[10px] text-gray-400 mt-1">Actual total saved in analysis period</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Target Savings Rate</p>
                <div className="flex items-baseline gap-2">
                  <p className="text-3xl font-bold text-indigo-400">{stats.savingsRate.toFixed(1)}%</p>
                  <span className="text-xs text-gray-500">of income</span>
                </div>
                <div className="w-full h-1.5 bg-gray-800 rounded-full mt-2 overflow-hidden">
                  <div 
                    className="h-full bg-indigo-500 rounded-full transition-all duration-1000" 
                    style={{ width: `${Math.min(100, stats.savingsRate)}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* History & Coverage Section */}
        {showHistory && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in fade-in slide-in-from-top-4 duration-500">
            {/* Coverage Timeline */}
            <section className="lg:col-span-2 bg-[#1e1e1e] border border-gray-800 rounded-xl p-6">
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-2">
                  <TableIcon size={18} className="text-indigo-400" />
                  <h2 className="text-lg font-semibold">Statement Coverage Timeline</h2>
                </div>
                <div className="flex items-center gap-4 text-[10px] text-gray-500">
                  <div className="flex items-center gap-1.5">
                    <div className="h-2 w-4 bg-indigo-600/40 border border-indigo-500/50 rounded" />
                    <span>Statement Span</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="h-2 w-2 bg-indigo-400 rounded-full" />
                    <span>Daily Activity</span>
                  </div>
                </div>
              </div>

              <div className="space-y-8">
                {BANK_FORMATS.map(bank => {
                  const now = new Date();
                  const startTime = new Date(now.getFullYear(), now.getMonth() - 11, 1).getTime();
                  const endTime = now.getTime();
                  const totalRange = endTime - startTime;

                  const getPos = (time: number) => Math.max(0, Math.min(100, ((time - startTime) / totalRange) * 100));

                  return (
                    <div key={bank} className="space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-gray-300">{bank}</span>
                        <span className="text-gray-500">Last 12 Months</span>
                      </div>
                      <div className="relative h-10 bg-[#2a2a2a] rounded-lg border border-gray-800 overflow-hidden group/timeline">
                        {/* Month Markers */}
                        {last12Months.map((m, i) => {
                          const [y, mm] = m.split('-').map(Number);
                          const pos = getPos(new Date(y, mm - 1, 1).getTime());
                          return (
                            <div 
                              key={m} 
                              className="absolute top-0 bottom-0 border-l border-gray-800/50 z-0" 
                              style={{ left: `${pos}%` }}
                            >
                              <span className="absolute top-full mt-1 -left-2 text-[8px] text-gray-600 uppercase">
                                {new Date(y, mm - 1, 1).toLocaleString('default', { month: 'short' })}
                              </span>
                            </div>
                          );
                        })}

                        {/* Statement Spans */}
                        {coverageStats.spans[bank].map(span => (
                          <div 
                            key={span.id}
                            className="absolute top-0 bottom-0 bg-indigo-600/20 border-x border-indigo-500/30 z-10 hover:bg-indigo-600/40 transition-colors"
                            style={{ 
                              left: `${getPos(span.start)}%`, 
                              width: `${getPos(span.end) - getPos(span.start)}%` 
                            }}
                            title={`${span.fileName}\n${new Date(span.start).toLocaleDateString()} - ${new Date(span.end).toLocaleDateString()}`}
                          />
                        ))}

                        {/* Daily Activity Dots */}
                        {(Array.from(coverageStats.daily[bank]) as string[]).map(dateStr => {
                          const [d, m, y] = dateStr.split('/').map(Number);
                          const time = new Date(y, m - 1, d).getTime();
                          if (time < startTime) return null;
                          return (
                            <div 
                              key={dateStr}
                              className="absolute top-1/2 -translate-y-1/2 w-1 h-1 bg-indigo-400 rounded-full z-20 opacity-60"
                              style={{ left: `${getPos(time)}%` }}
                            />
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-12 pt-6 border-t border-gray-800/50 flex flex-wrap items-center justify-between gap-4">
                <p className="text-[10px] text-gray-500 max-w-md">
                  The timeline shows the exact date ranges covered by your uploaded CSVs. 
                  Blue blocks represent statement spans, while dots indicate specific days with transactions.
                </p>
                {(last12Months as string[]).some(m => {
                  const [y, mm] = m.split('-').map(Number);
                  const start = new Date(y, mm - 1, 1).getTime();
                  const end = new Date(y, mm, 0).getTime();
                  return BANK_FORMATS.some(bank => {
                    const hasSpan = coverageStats.spans[bank].some(s => s.start <= end && s.end >= start);
                    return !hasSpan;
                  });
                }) && (
                  <div className="flex items-center gap-2 text-[10px] text-amber-400 bg-amber-900/10 px-3 py-1.5 rounded-lg border border-amber-900/20">
                    <AlertCircle size={12} />
                    <span>Gaps detected in statement continuity.</span>
                  </div>
                )}
              </div>
            </section>

            {/* Upload Log */}
            <section className="bg-[#1e1e1e] border border-gray-800 rounded-xl p-6 flex flex-col">
              <div className="flex items-center gap-2 mb-6">
                <RefreshCcw size={18} className="text-indigo-400" />
                <h2 className="text-lg font-semibold">Upload History</h2>
              </div>
              <div className="flex-1 space-y-4 overflow-y-auto max-h-[400px] pr-2 custom-scrollbar">
                {uploadLogs.length > 0 ? (
                  uploadLogs.map((log) => (
                    <div key={log.id} className="p-3 bg-[#2a2a2a] border border-gray-700 rounded-lg space-y-2 group/log">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-indigo-400 uppercase">{log.bank}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-gray-500">
                            {new Date(log.uploadedAt).toLocaleDateString()}
                          </span>
                          <button 
                            onClick={() => handleDeleteLog(log.id)}
                            disabled={isAnalyzing}
                            className={cn(
                              "p-1 text-gray-600 transition-all",
                              isAnalyzing ? "opacity-30 cursor-not-allowed" : "hover:text-red-400 opacity-0 group-hover/log:opacity-100"
                            )}
                            title="Delete Log"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                      <div className="space-y-1">
                        <p className="text-sm font-medium truncate" title={log.fileName}>{log.fileName}</p>
                        <div className="flex items-center justify-between text-[10px] text-gray-500">
                          <span>{log.transactionCount} transactions</span>
                          {log.periodStart && log.periodEnd && (
                            <span className="bg-gray-800 px-1.5 py-0.5 rounded">
                              {new Date(log.periodStart).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })} - {new Date(log.periodEnd).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-center text-gray-500 space-y-2">
                    <CloudOff size={32} className="opacity-20" />
                    <p className="text-sm">No upload history found.</p>
                  </div>
                )}
              </div>
            </section>
          </div>
        )}

        {/* Charts Section */}
        {allTransactions.length > 0 && (
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-[#1e1e1e] border border-gray-800 p-6 rounded-xl">
              <div className="flex items-center gap-2 mb-6">
                <PieChart size={18} className="text-indigo-400" />
                <h2 className="text-lg font-semibold">Spending by Category</h2>
              </div>
              <div className="h-[300px] flex justify-center">
                <Doughnut 
                  data={categoryChartData} 
                  options={{
                    maintainAspectRatio: false,
                    plugins: {
                      legend: {
                        position: 'right',
                        labels: { color: '#9ca3af', usePointStyle: true, padding: 20 }
                      }
                    }
                  }} 
                />
              </div>
            </div>
            <div className="bg-[#1e1e1e] border border-gray-800 p-6 rounded-xl">
              <div className="flex items-center gap-2 mb-6">
                <BarChart3 size={18} className="text-indigo-400" />
                <h2 className="text-lg font-semibold">Monthly Trend</h2>
              </div>
              <div className="h-[300px]">
                <Bar 
                  data={trendChartData}
                  options={{
                    maintainAspectRatio: false,
                    scales: {
                      y: { grid: { color: '#2a2a2a' }, ticks: { color: '#9ca3af' } },
                      x: { grid: { display: false }, ticks: { color: '#9ca3af' } }
                    },
                    plugins: { legend: { display: false } }
                  }}
                />
              </div>
            </div>
          </section>
        )}

        {/* Subscription Hunter */}
        {subscriptions.length > 0 && (
          <section className="bg-[#1e1e1e] border border-gray-800 rounded-xl overflow-hidden">
            <div className="p-6 border-b border-gray-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <RefreshCcw size={18} className="text-amber-400" />
                <h2 className="text-lg font-semibold">Detected Subscriptions</h2>
              </div>
              <span className="text-xs bg-amber-900/30 text-amber-400 px-2 py-1 rounded border border-amber-900/50">
                AI Detected
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-gray-800">
              {subscriptions.slice(0, 4).map((sub, i) => (
                <div key={i} className="p-6 space-y-3">
                  <p className="text-sm text-gray-400 font-medium truncate" title={sub.merchant}>{sub.merchant}</p>
                  <div className="flex items-end justify-between">
                    <div>
                      <p className="text-xl font-bold">{formatCurrency(sub.avgAmount)}</p>
                      <p className="text-xs text-gray-500">Avg. Monthly</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-amber-400">{formatCurrency(sub.annualCost)}</p>
                      <p className="text-xs text-gray-500">Annual Cost</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Transaction Table */}
        <section className="bg-[#1e1e1e] border border-gray-800 rounded-xl overflow-hidden">
          <div className="p-6 border-b border-gray-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <TableIcon size={18} className="text-indigo-400" />
              <h2 className="text-lg font-semibold">Transactions</h2>
            </div>
            <div className="flex items-center gap-4 flex-1 max-w-3xl">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={18} />
                <input 
                  type="text"
                  placeholder="Search descriptions, categories..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full bg-[#2a2a2a] border border-gray-700 rounded-lg pl-10 pr-4 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <button 
                onClick={() => setHideTransfers(!hideTransfers)}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors border",
                  hideTransfers 
                    ? "bg-indigo-600/20 border-indigo-500/50 text-indigo-400 hover:bg-indigo-600/30" 
                    : "bg-[#2a2a2a] border-gray-700 text-gray-400 hover:bg-[#333]"
                )}
              >
                <RefreshCcw size={14} className={cn(hideTransfers && "text-indigo-400")} />
                <span>{hideTransfers ? "Transfers Hidden" : "Show Transfers"}</span>
              </button>
              {isFiltered && (
                <button 
                  onClick={clearFilters}
                  className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1 whitespace-nowrap"
                >
                  <RefreshCcw size={12} />
                  Clear Filters
                </button>
              )}
            </div>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#252525] text-gray-400 text-[10px] uppercase tracking-wider">
                  <th className="px-6 py-4 font-semibold group cursor-pointer hover:text-white transition-colors" onClick={() => handleSort('date')}>
                    <div className="flex items-center gap-1">
                      Date
                      <SortIcon column="date" />
                    </div>
                  </th>
                  <th className="px-6 py-4 font-semibold group cursor-pointer hover:text-white transition-colors" onClick={() => handleSort('description')}>
                    <div className="flex items-center gap-1">
                      Description
                      <SortIcon column="description" />
                    </div>
                  </th>
                  <th className="px-6 py-4 font-semibold">
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1 cursor-pointer hover:text-white transition-colors group" onClick={() => handleSort('category')}>
                        Category
                        <SortIcon column="category" />
                      </div>
                      <div className="relative group/filter">
                        <Filter size={12} className={cn("cursor-pointer hover:text-indigo-400 transition-colors", selectedCategory !== 'all' && "text-indigo-400")} />
                        <select 
                          value={selectedCategory}
                          onChange={(e) => setSelectedCategory(e.target.value)}
                          className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                        >
                          <option value="all">All Categories</option>
                          {categories.map(cat => (
                            <option key={cat} value={cat}>{cat}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </th>
                  <th className="px-6 py-4 font-semibold group cursor-pointer hover:text-white transition-colors" onClick={() => handleSort('amount')}>
                    <div className="flex items-center gap-1">
                      Amount
                      <SortIcon column="amount" />
                    </div>
                  </th>
                  <th className="px-6 py-4 font-semibold">
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1 cursor-pointer hover:text-white transition-colors group" onClick={() => handleSort('bank')}>
                        Bank
                        <SortIcon column="bank" />
                      </div>
                      <div className="relative group/filter">
                        <Filter size={12} className={cn("cursor-pointer hover:text-indigo-400 transition-colors", selectedBankFilter !== 'all' && "text-indigo-400")} />
                        <select 
                          value={selectedBankFilter}
                          onChange={(e) => setSelectedBankFilter(e.target.value)}
                          className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                        >
                          <option value="all">All Banks</option>
                          {banks.map(bank => (
                            <option key={bank} value={bank}>{bank}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {filteredTransactions.length > 0 ? (
                  filteredTransactions.map((t) => (
                    <tr key={t.id} className="hover:bg-[#252525] transition-colors group/row">
                      <td className="px-6 py-4 text-sm text-gray-400 font-mono whitespace-nowrap">{t.date}</td>
                      <td className="px-6 py-4">
                        <div className="flex flex-col">
                          <span className="text-sm font-medium text-gray-200">{t.description}</span>
                          {t.category === 'Transfer' && (
                            <span className="text-[10px] text-gray-500 italic">Internal Transfer / Pot Movement</span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={cn(
                          "text-[10px] px-2 py-0.5 rounded-full font-medium uppercase tracking-wider",
                          t.category === 'Income' ? "bg-green-900/30 text-green-400 border border-green-900/50" :
                          t.category === 'Savings & Investments' ? "bg-amber-900/30 text-amber-400 border border-amber-900/50" :
                          t.category === 'Transfer' ? "bg-gray-800 text-gray-400 border border-gray-700" :
                          "bg-indigo-900/20 text-indigo-400 border border-indigo-900/50"
                        )}>
                          {t.category}
                        </span>
                      </td>
                      <td className={cn(
                        "px-6 py-4 text-sm font-bold text-right font-mono whitespace-nowrap",
                        t.amount > 0 ? "text-green-400" : "text-gray-200"
                      )}>
                        {formatCurrency(t.amount)}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <span className={cn(
                          "text-[10px] px-1.5 py-0.5 rounded font-bold",
                          t.bank === 'Barclaycard' ? "bg-blue-900/20 text-blue-400" :
                          t.bank === 'Amex' ? "bg-indigo-900/20 text-indigo-400" :
                          "bg-teal-900/20 text-teal-400"
                        )}>
                          {t.bank.toUpperCase()}
                        </span>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center text-gray-500">
                      <div className="flex flex-col items-center gap-2">
                        <AlertCircle size={32} />
                        <p>No transactions found. Upload a CSV to get started.</p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

      </div>
    </div>
  );
}
