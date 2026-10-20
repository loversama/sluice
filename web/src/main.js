import { createApp } from "vue";
import { createPinia } from "pinia";

// Only the Element Plus pieces we actually use, with their own styles. Importing the full
// library pulled in ~1.3MB for a dashboard that needs a drawer, a switch, a menu and a toast.
import { ElDrawer, ElDropdown, ElDropdownItem, ElDropdownMenu, ElSwitch } from "element-plus";
import "element-plus/es/components/drawer/style/css";
import "element-plus/es/components/dropdown/style/css";
import "element-plus/es/components/dropdown-item/style/css";
import "element-plus/es/components/dropdown-menu/style/css";
import "element-plus/es/components/switch/style/css";
import "element-plus/es/components/message/style/css";
import "element-plus/es/components/notification/style/css";

import App from "./App.vue";
import router from "./router.js";
import "./style.css";

createApp(App)
    .use(createPinia())
    .use(router)
    .component("ElDrawer", ElDrawer)
    .component("ElDropdown", ElDropdown)
    .component("ElDropdownItem", ElDropdownItem)
    .component("ElDropdownMenu", ElDropdownMenu)
    .component("ElSwitch", ElSwitch)
    .mount("#app");
