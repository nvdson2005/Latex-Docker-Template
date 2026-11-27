import './styles.css';
import { mountWorkspace } from './workspace.js';

const root = document.querySelector<HTMLElement>('#workspace');
if (root) {
  const workspace = mountWorkspace(root, () => {});
  void workspace.refresh().then(() => workspace.open('main.tex'));
}
