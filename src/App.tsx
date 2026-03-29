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
  LogIn,
  LogOut,
  Cloud,
  CloudOff
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { auth, db } from './firebase';
import { 
  onAuthStateChanged, 
  signInWithPopup, 
  GoogleAuthProvider, 
  signOut,
  User
} from 'firebase/auth';
import { 
  collection, 
  onSnapshot, 
  query, 
  orderBy, 
  writeBatch, 
  doc, 
  setDoc,
  serverTimestamp,
  deleteDoc,
  getDocs
} from 'firebase/firestore';

// --- Utility ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
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
  'Transfer': ['direct debit', 'payment received', 'amex', 'american express', 'barclaycard', 'credit card', 'transfer'],
  'Groceries': ['tesco', 'sainsbury', 'asda', 'lidl', 'aldi', 'co-op', 'coop', '7 11', 'waitrose', 'marks & spencer', 'm&s'],
  'Transport': ['uber', 'bolt', 'tfl', 'grab', 'fuel', 'petrol', 'trainline', 'eurostar', 'shell', 'bp'],
  'Eating Out': ['wetherspoon', 'nandos', 'starbucks', 'costa', 'mcdonalds', 'subway', 'restaurant', 'bar', 'pub', 'deliveroo', 'just eat', 'uber eats'],
  'Shopping': ['amazon', 'amzn', 'argos', 'boots', 'next', 'zara', 'h&m', 'ebay', 'apple'],
  'Entertainment': ['netflix', 'spotify', 'disney', 'cinema', 'steam', 'playstation', 'xbox'],
  'Bills': ['smarty', 'virgin media', 'bt ', 'water', 'electric', 'gas', 'council', 'insurance', 'rent', 'mortgage'],
  'Subscriptions': ['proton', 'porkbun', 'google play', 'icloud', 'adobe', 'microsoft', 'chatgpt', 'openai']
};

const BANK_FORMATS = ['Barclaycard', 'Amex', 'Starling'] as const;
type BankType = typeof BANK_FORMATS[number];

// --- Logic Functions ---

function generateFingerprint(t: Omit<Transaction, 'id'>): string {
  const data = `${t.date}|${t.description}|${t.amount}|${t.bank}`;
  // Simple hash for fingerprinting
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

function autoCategorize(description: string): string {
  const desc = description.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(kw => desc.includes(kw.toLowerCase()))) {
      return category;
    }
  }
  return 'Uncategorized';
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
  let val = parseFloat(amountStr.replace(/,/g, ''));
  if (isNaN(val)) return 0;
  
  if (bank === 'Barclaycard' || bank === 'Amex') {
    // Positive is spend -> convert to negative
    return -Math.abs(val);
  }
  // Starling is already correct
  return val;
}

function detectSubscriptions(transactions: Transaction[]): Subscription[] {
  const groups: Record<string, Transaction[]> = {};
  
  transactions.forEach(t => {
    if (t.amount >= 0) return; // Only spending
    
    // Normalize description: lowercase, remove numbers and special chars
    const normalizedDesc = t.description
      .toLowerCase()
      .replace(/[0-9]/g, '')
      .replace(/[*#]/g, '')
      .trim();
      
    if (!groups[normalizedDesc]) groups[normalizedDesc] = [];
    groups[normalizedDesc].push(t);
  });
  
  const subs: Subscription[] = [];
  
  Object.entries(groups).forEach(([desc, txs]) => {
    if (txs.length < 2) return;
    
    // Check if amounts are within 10%
    const avgAmount = txs.reduce((sum, t) => sum + t.amount, 0) / txs.length;
    const isConsistent = txs.every(t => Math.abs(t.amount - avgAmount) <= Math.abs(avgAmount * 0.1));
    
    if (isConsistent) {
      subs.push({
        merchant: txs[0].description,
        frequency: 'Monthly', // Simplified assumption
        avgAmount: Math.abs(avgAmount),
        annualCost: Math.abs(avgAmount) * 12,
        count: txs.length
      });
    }
  });
  
  return subs.sort((a, b) => b.annualCost - a.annualCost);
}

// --- Components ---

export default function App() {
  const [allTransactions, setAllTransactions] = useState<Transaction[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [selectedBank, setSelectedBank] = useState<BankType>('Barclaycard');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedMonth, setSelectedMonth] = useState<string>('all'); // Format: YYYY-MM
  const [sortConfig, setSortConfig] = useState<{ key: keyof Transaction, direction: 'asc' | 'desc' }>({ key: 'date', direction: 'desc' });

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Firestore Sync
  useEffect(() => {
    if (!user) {
      // Load from localStorage if not logged in
      const saved = localStorage.getItem('transactions');
      if (saved) {
        try {
          setAllTransactions(JSON.parse(saved));
        } catch (e) {
          console.error("Failed to parse saved transactions", e);
        }
      }
      return;
    }

    // Real-time sync from Firestore
    const q = query(
      collection(db, `users/${user.uid}/transactions`),
      orderBy('date', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const txs: Transaction[] = [];
      snapshot.forEach((doc) => {
        txs.push({ id: doc.id, ...doc.data() } as Transaction);
      });
      setAllTransactions(txs);
      // Also update localStorage as a cache
      localStorage.setItem('transactions', JSON.stringify(txs));
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `users/${user.uid}/transactions`);
    });

    return () => unsubscribe();
  }, [user]);

  const handleLogin = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Login failed", error);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setAllTransactions([]);
      localStorage.removeItem('transactions');
    } catch (error) {
      console.error("Logout failed", error);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsAnalyzing(true);
    Papa.parse(file, {
      complete: async (results) => {
        const data = results.data as string[][];
        const parsedTxs: Omit<Transaction, 'id'>[] = [];
        
        if (selectedBank === 'Barclaycard') {
          data.forEach((row) => {
            if (row.length < 7 || !row[0]) return;
            const rawDesc = row[1];
            const rawCat = row[4] || 'Uncategorized';
            parsedTxs.push({
              date: normalizeDate(row[0], 'Barclaycard'),
              description: rawDesc,
              amount: normalizeAmount(row[6], 'Barclaycard'),
              category: rawCat === 'Uncategorized' ? autoCategorize(rawDesc) : rawCat,
              bank: 'Barclaycard'
            });
          });
        } else if (selectedBank === 'Amex') {
          data.slice(1).forEach((row) => {
            if (row.length < 11 || !row[0]) return;
            const rawDesc = row[1];
            const rawCat = row[10] ? row[10].split('-')[0].trim() : 'Uncategorized';
            parsedTxs.push({
              date: normalizeDate(row[0], 'Amex'),
              description: rawDesc,
              amount: normalizeAmount(row[2], 'Amex'),
              category: rawCat === 'Uncategorized' ? autoCategorize(rawDesc) : rawCat,
              bank: 'Amex'
            });
          });
        } else if (selectedBank === 'Starling') {
          data.slice(1).forEach((row) => {
            if (row.length < 8 || !row[0]) return;
            const rawDesc = row[1];
            const rawCat = row[6] ? row[6].replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : 'Uncategorized';
            parsedTxs.push({
              date: normalizeDate(row[0], 'Starling'),
              description: rawDesc,
              amount: normalizeAmount(row[4], 'Starling'),
              category: rawCat === 'Uncategorized' ? autoCategorize(rawDesc) : rawCat,
              bank: 'Starling'
            });
          });
        }

        if (user) {
          // Upload to Firestore with fingerprinting
          const batch = writeBatch(db);
          parsedTxs.forEach(tx => {
            const fingerprint = generateFingerprint(tx);
            const docRef = doc(db, `users/${user.uid}/transactions`, fingerprint);
            batch.set(docRef, {
              ...tx,
              id: fingerprint, // Ensure ID is in the document data for rules validation
              uid: user.uid,
              createdAt: serverTimestamp()
            }, { merge: true });
          });
          
          try {
            await batch.commit();
          } catch (error) {
            handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}/transactions`);
          }
        } else {
          // Fallback to local state if not logged in
          const newTransactions = parsedTxs.map((tx, idx) => ({
            ...tx,
            id: `local-${Date.now()}-${idx}`
          }));
          setAllTransactions(prev => [...prev, ...newTransactions]);
        }

        setIsAnalyzing(false);
        e.target.value = '';
      },
      error: (err) => {
        console.error("CSV Parse Error", err);
        setIsAnalyzing(false);
        alert("Failed to parse CSV file.");
      }
    });
  };

  const clearData = async () => {
    if (confirm("Are you sure you want to clear all transaction data?")) {
      if (user) {
        try {
          // Clear Firestore (Note: for large datasets, this should be a cloud function or handled in chunks)
          const q = query(collection(db, `users/${user.uid}/transactions`));
          const snapshot = await getDocs(q);
          const batch = writeBatch(db);
          snapshot.forEach((doc) => batch.delete(doc.ref));
          await batch.commit();
        } catch (error) {
          handleFirestoreError(error, OperationType.DELETE, `users/${user.uid}/transactions`);
        }
      }
      setAllTransactions([]);
      localStorage.removeItem('transactions');
      setSelectedMonth('all');
    }
  };

  // --- Derived Data ---

  const availableMonths = useMemo(() => {
    const months = new Set<string>();
    allTransactions.forEach(t => {
      const [d, m, y] = t.date.split('/');
      months.add(`${y}-${m}`);
    });
    return Array.from(months).sort().reverse();
  }, [allTransactions]);
  
  const filteredTransactions = useMemo(() => {
    let result = allTransactions;

    // Month filter
    if (selectedMonth !== 'all') {
      result = result.filter(t => {
        const [d, m, y] = t.date.split('/');
        return `${y}-${m}` === selectedMonth;
      });
    }

    // Search filter
    result = result.filter(t => 
      t.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
      t.category.toLowerCase().includes(searchTerm.toLowerCase()) ||
      t.bank.toLowerCase().includes(searchTerm.toLowerCase())
    );

    result.sort((a, b) => {
      let valA = a[sortConfig.key];
      let valB = b[sortConfig.key];

      if (sortConfig.key === 'date') {
        const [dA, mA, yA] = a.date.split('/').map(Number);
        const [dB, mB, yB] = b.date.split('/').map(Number);
        valA = new Date(yA, mA - 1, dA).getTime();
        valB = new Date(yB, mB - 1, dB).getTime();
      }

      if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
      if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });

    return result;
  }, [allTransactions, searchTerm, sortConfig, selectedMonth]);

  const stats = useMemo(() => {
    // Use filtered transactions for stats to respect month filter
    const nonTransferTransactions = filteredTransactions.filter(t => t.category !== 'Transfer');
    
    const totalSpent = nonTransferTransactions.filter(t => t.amount < 0).reduce((sum, t) => sum + t.amount, 0);
    const totalIncome = nonTransferTransactions.filter(t => t.amount > 0).reduce((sum, t) => sum + t.amount, 0);
    return {
      spent: Math.abs(totalSpent),
      income: totalIncome,
      net: totalIncome + totalSpent,
      count: filteredTransactions.length
    };
  }, [filteredTransactions]);

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

  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(val);
  };

  const formatMonthKey = (key: string) => {
    if (key === 'all') return 'All Time';
    const [y, m] = key.split('-');
    return new Date(parseInt(y), parseInt(m) - 1).toLocaleString('default', { month: 'long', year: 'numeric' });
  };

  return (
    <div className="min-h-screen bg-[#121212] text-white font-sans p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-8">
        
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Transaction Dashboard</h1>
            <div className="flex items-center gap-2 mt-1">
              <p className="text-gray-400">Unified view of your bank statements</p>
              {user && (
                <div className="flex items-center gap-1.5 px-2 py-0.5 bg-green-900/20 text-green-400 text-xs rounded-full border border-green-900/30">
                  <Cloud size={12} />
                  <span>Cloud Synced</span>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {isAuthReady && (
              user ? (
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-400 hidden sm:inline">{user.email}</span>
                  <button 
                    onClick={handleLogout}
                    className="flex items-center gap-2 px-4 py-2 bg-[#2a2a2a] text-gray-300 border border-gray-700 rounded-lg hover:bg-[#333] transition-colors"
                  >
                    <LogOut size={18} />
                    <span>Logout</span>
                  </button>
                </div>
              ) : (
                <button 
                  onClick={handleLogin}
                  className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-500/20"
                >
                  <LogIn size={18} />
                  <span>Login with Google</span>
                </button>
              )
            )}
            <button 
              onClick={clearData}
              className="flex items-center gap-2 px-4 py-2 bg-red-900/20 text-red-400 border border-red-900/50 rounded-lg hover:bg-red-900/30 transition-colors"
            >
              <Trash2 size={18} />
              <span>Clear Data</span>
            </button>
          </div>
        </header>

        {/* Month Filter & Upload Section */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <section className="lg:col-span-2 bg-[#1e1e1e] border border-gray-800 rounded-xl p-6">
            <div className="flex flex-col md:flex-row items-end gap-6">
              <div className="w-full md:w-64 space-y-2">
                <label className="text-sm font-medium text-gray-400">Select Bank Format</label>
                <select 
                  value={selectedBank}
                  onChange={(e) => setSelectedBank(e.target.value as BankType)}
                  className="w-full bg-[#2a2a2a] border border-gray-700 rounded-lg px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  {BANK_FORMATS.map(bank => (
                    <option key={bank} value={bank}>{bank}</option>
                  ))}
                </select>
              </div>
              <div className="flex-1 w-full space-y-2">
                <label className="text-sm font-medium text-gray-400">Upload CSV File</label>
                <div className="relative">
                  <input 
                    type="file" 
                    accept=".csv"
                    onChange={handleFileUpload}
                    className="hidden" 
                    id="csv-upload"
                  />
                  <label 
                    htmlFor="csv-upload"
                    className="flex items-center justify-center gap-3 w-full bg-[#2a2a2a] border-2 border-dashed border-gray-700 rounded-lg px-6 py-8 cursor-pointer hover:border-indigo-500 hover:bg-[#333] transition-all group"
                  >
                    <Upload className="text-gray-500 group-hover:text-indigo-400" />
                    <span className="text-gray-400 group-hover:text-gray-200">
                      {isAnalyzing ? "Processing..." : "Click to upload or drag and drop"}
                    </span>
                  </label>
                </div>
              </div>
            </div>
          </section>

          {/* Month Selector */}
          <section className="bg-[#1e1e1e] border border-gray-800 rounded-xl p-6">
            <label className="text-sm font-medium text-gray-400 block mb-4">Viewing Period</label>
            <div className="space-y-2 max-h-[140px] overflow-y-auto pr-2 custom-scrollbar">
              <button 
                onClick={() => setSelectedMonth('all')}
                className={cn(
                  "w-full text-left px-4 py-2 rounded-lg transition-colors text-sm",
                  selectedMonth === 'all' ? "bg-indigo-600 text-white" : "bg-[#2a2a2a] text-gray-400 hover:bg-[#333]"
                )}
              >
                All Time
              </button>
              {availableMonths.map(month => (
                <button 
                  key={month}
                  onClick={() => setSelectedMonth(month)}
                  className={cn(
                    "w-full text-left px-4 py-2 rounded-lg transition-colors text-sm",
                    selectedMonth === month ? "bg-indigo-600 text-white" : "bg-[#2a2a2a] text-gray-400 hover:bg-[#333]"
                  )}
                >
                  {formatMonthKey(month)}
                </button>
              ))}
            </div>
          </section>
        </div>

        {/* Summary Cards */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-[#1e1e1e] border border-gray-800 p-6 rounded-xl space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-gray-400 text-sm font-medium">Total Spent</span>
              <TrendingDown className="text-red-400" size={20} />
            </div>
            <p className="text-2xl font-bold text-red-400">{formatCurrency(stats.spent)}</p>
          </div>
          <div className="bg-[#1e1e1e] border border-gray-800 p-6 rounded-xl space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-gray-400 text-sm font-medium">Total Income</span>
              <TrendingUp className="text-green-400" size={20} />
            </div>
            <p className="text-2xl font-bold text-green-400">{formatCurrency(stats.income)}</p>
          </div>
          <div className="bg-[#1e1e1e] border border-gray-800 p-6 rounded-xl space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-gray-400 text-sm font-medium">Net Position</span>
              <Wallet className="text-indigo-400" size={20} />
            </div>
            <p className={cn("text-2xl font-bold", stats.net >= 0 ? "text-green-400" : "text-red-400")}>
              {formatCurrency(stats.net)}
            </p>
          </div>
          <div className="bg-[#1e1e1e] border border-gray-800 p-6 rounded-xl space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-gray-400 text-sm font-medium">Transactions</span>
              <RefreshCcw className="text-gray-500" size={20} />
            </div>
            <p className="text-2xl font-bold">{stats.count}</p>
          </div>
        </section>

        {/* Charts Section */}
        {allTransactions.length > 0 && (
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-[#1e1e1e] border border-gray-800 p-6 rounded-xl">
              <div className="flex items-center gap-2 mb-6">
                <PieChart size={18} className="text-indigo-400" />
                <h2 className="text-lg font-semibold">Spending by Category {selectedMonth !== 'all' && `(${formatMonthKey(selectedMonth)})`}</h2>
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
            {selectedMonth === 'all' ? (
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
            ) : (
              <div className="bg-[#1e1e1e] border border-gray-800 p-6 rounded-xl flex flex-col items-center justify-center text-center space-y-4">
                <Calendar size={48} className="text-gray-700" />
                <div>
                  <h3 className="text-lg font-medium text-gray-300">Viewing {formatMonthKey(selectedMonth)}</h3>
                  <p className="text-sm text-gray-500 max-w-xs mx-auto">
                    The summary and category breakdown above are now filtered to this specific month.
                  </p>
                </div>
                <button 
                  onClick={() => setSelectedMonth('all')}
                  className="text-indigo-400 text-sm hover:underline"
                >
                  Back to All Time Trend
                </button>
              </div>
            )}
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
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={18} />
              <input 
                type="text"
                placeholder="Search descriptions, categories..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full bg-[#2a2a2a] border border-gray-700 rounded-lg pl-10 pr-4 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#252525] text-gray-400 text-xs uppercase tracking-wider">
                  <th className="px-6 py-4 font-semibold cursor-pointer hover:text-white" onClick={() => setSortConfig({ key: 'date', direction: sortConfig.direction === 'asc' ? 'desc' : 'asc' })}>Date</th>
                  <th className="px-6 py-4 font-semibold">Description</th>
                  <th className="px-6 py-4 font-semibold">Category</th>
                  <th className="px-6 py-4 font-semibold cursor-pointer hover:text-white" onClick={() => setSortConfig({ key: 'amount', direction: sortConfig.direction === 'asc' ? 'desc' : 'asc' })}>Amount</th>
                  <th className="px-6 py-4 font-semibold">Bank</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {filteredTransactions.length > 0 ? (
                  filteredTransactions.map((t) => (
                    <tr key={t.id} className="hover:bg-[#252525] transition-colors">
                      <td className="px-6 py-4 text-sm text-gray-300 whitespace-nowrap">{t.date}</td>
                      <td className="px-6 py-4 text-sm font-medium">{t.description}</td>
                      <td className="px-6 py-4">
                        <span className="text-xs bg-gray-800 text-gray-300 px-2 py-1 rounded">
                          {t.category}
                        </span>
                      </td>
                      <td className={cn("px-6 py-4 text-sm font-bold whitespace-nowrap", t.amount >= 0 ? "text-green-400" : "text-red-400")}>
                        {formatCurrency(t.amount)}
                      </td>
                      <td className="px-6 py-4 text-xs text-gray-500">{t.bank}</td>
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
