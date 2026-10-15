import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './App';
import {DialogProvider} from './dialogs';
import './styles.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><DialogProvider><App/></DialogProvider></React.StrictMode>);
