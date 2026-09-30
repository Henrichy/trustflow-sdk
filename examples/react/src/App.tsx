import React, { useState } from 'react';
import { useWallet, useEscrow, useBalance } from 'trustflow-sdk';
import './App.css';

function App() {
  const { isConnected, address, connect, disconnect } = useWallet();
  const { balance, loading: balanceLoading } = useBalance(address);
  const { createEscrow, releaseEscrow, loading: escrowLoading } = useEscrow();

  const [amount, setAmount] = useState('100');
  const [recipient, setRecipient] = useState('');

  const handleConnect = async () => {
    try {
      await connect();
    } catch (e) {
      console.error('Failed to connect wallet:', e);
    }
  };

  const handleCreate = async () => {
    if (!recipient) return;
    try {
      await createEscrow({
        amount,
        recipient,
        assetCode: 'USDC'
      });
      alert('Escrow created successfully!');
    } catch (e) {
      console.error('Escrow creation failed', e);
      alert('Error creating escrow');
    }
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>Trustflow React Example</h1>
        {!isConnected ? (
          <button onClick={handleConnect}>Connect Wallet</button>
        ) : (
          <div>
            <p>Connected: {address}</p>
            <p>Balance: {balanceLoading ? 'Loading...' : `${balance} XLM`}</p>
            <button onClick={disconnect}>Disconnect</button>
            
            <div className="escrow-form">
              <h3>Create Escrow</h3>
              <input 
                type="text" 
                placeholder="Recipient Address" 
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              />
              <input 
                type="number" 
                placeholder="Amount" 
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <button onClick={handleCreate} disabled={escrowLoading || !recipient}>
                {escrowLoading ? 'Creating...' : 'Create Escrow'}
              </button>
            </div>
          </div>
        )}
      </header>
    </div>
  );
}

export default App;
