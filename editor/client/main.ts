import './styles.css';
import { mountCompileControls } from './compile.js';
import { mountPreview } from './preview.js';
import { mountWorkspace } from './workspace.js';

const root = document.querySelector<HTMLElement>('#workspace');
if (root) {
  const workspace = mountWorkspace(root, () => controls.onSaved());
  const preview = mountPreview(root.querySelector<HTMLElement>('#pdf-preview')!);
  const controls = mountCompileControls(root.querySelector<HTMLElement>('#compile-controls')!, workspace, preview);
  void workspace.refresh().then(() => workspace.open('main.tex'));
}
