import './App.css'
import { useEffect, useState } from 'react'
import { observeAppearance } from './utils/appearance'

function App() {
  const [appearanceError, setAppearanceError] = useState('');
  useEffect(() => observeAppearance(undefined, error => {
    setAppearanceError(`Could not load appearance: ${error.message}`);
  }), []);
  const openDashboard = () => {
    chrome.tabs.create({ url: 'dashboard.html' });
  };

  return (
    <div className="app-container">
      <div className="popup-masthead">
        <span className="popup-masthead-name">SimpleReader</span>
        <span className="popup-masthead-sub">rss · atom · rdf</span>
      </div>
      <button className="popup-open-btn" onClick={openDashboard}>
        Open Reader →
      </button>
      {appearanceError && <p className="popup-error" role="alert">{appearanceError}</p>}
    </div>
  )
}

export default App
