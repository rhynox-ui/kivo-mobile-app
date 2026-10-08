import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { kivoTheme } from '../theme/kivoTheme';
import { parseUnits } from 'viem';
import { NEAR_USDC, NEAR_USDC_DECIMALS } from '@kivo/trading/core/chainData';
import { fetchNearTokenBalance } from '@kivo/trading/core/nearTrade';
import { nearCashMoveChains, nearCashMoveRequest, nearUsdcDepositCall } from '@kivo/trading/core/nearCashMoves';
import { fetchOneClickTokens, requestOneClickQuote, submitOneClickDepositTx } from '@kivo/trading/core/oneClick';
import { fundOneClickQuote } from '@kivo/trading/core/oneClickDeposits';
import { oneClickSwapStore } from '@kivo/trading/wallet/oneClickSwapStore';
import { nearView } from '@kivo/trading/core/nearRpc';

import { getWalletSession, loadWalletSession, subscribeToWallet, withDeviceAccounts, type WalletSession } from '../state/walletStore';
import { useSettings } from '../state/settingsStore';
import { addNotification } from '../state/notificationStore';
import { markOwnAction } from '../wallet/depositWatcher';
import { CHAIN_LABEL, type ChainKey } from '@kivo/trading/core/chainData';
import { clearCashBalanceCache, fetchCashBalances, totalCashUsd, CASH_CHAINS, cashAssetSymbol, type CashBalanceRow } from '@kivo/trading/kivo/balances';
import { isValidRecipientAddress, withdrawUsdc } from '@kivo/trading/kivo/cash';
import { fetchGaslessStatus, type GaslessStatus } from '@kivo/trading/kivo/gasless';
import { formatAmount, formatUsd, shortAddress } from '@kivo/trading/kivo/tokens';
import { NetworkIcon } from '../wallet/NetworkIcon';
import QRCode from 'react-native-qrcode-svg';

type Sheet = null | 'deposit' | 'withdraw';
type DepositNetwork = ChainKey | 'near';
type WithdrawNetwork = ChainKey | 'near';

const DEPOSIT_CHAINS: DepositNetwork[] = [...CASH_CHAINS, 'near'];
