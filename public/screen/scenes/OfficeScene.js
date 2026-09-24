import { PixelScene } from './PixelScene.js';
import { paintOfficeRoom, paintOfficeProp } from './officeArt.js';

export class OfficeScene extends PixelScene {
  static THEME_ID = 'office';
  static TITLE = '共享辦公室';
  static SUBTITLE = 'THE SHARED OFFICE　 /　一起把事情做好';
  static paintRoom = paintOfficeRoom;
  static paintProp = paintOfficeProp;
  static FALLBACK = ['plant', '綠色植栽', '辦公室裡的一點綠，深呼吸一下'];
  static ITEMS = {
    k_cart: ['whiteboard', '行動白板', '把想法畫出來吧'],
    k_island: ['meeting', '會議桌', '五分鐘站立會議開始！'],
    k_dining: ['roundtable', '圓桌', '找張椅子，一起討論'],
    k_stool_l: ['chair', '左側座椅', '轉一圈，換個角度想'],
    k_stool_r: ['chair', '右側座椅', '轉一圈，換個角度想'],
    k_pantry: ['bookshelf', '書櫃', '借一本書，交換一個推薦'],
    k_dishes: ['lockers', '檔案櫃', '資料都歸檔好了'],
    k_market: ['snack', '零食吧', '補充能量，來點點心'],
    spk_l: ['cooler', '飲水機', '咕嚕咕嚕，記得喝水'],
    spk_r: ['vending', '咖啡販賣機', '一杯咖啡，開啟好心情'],
    tbl_1: ['desk', '1號工作桌', '螢幕亮起，開工囉'],
    tbl_2: ['desk', '2號工作桌', '螢幕亮起，開工囉'],
    tbl_3: ['desk', '3號工作桌', '螢幕亮起，開工囉'],
    sofa_1: ['sofa', '窗邊沙發', '坐下來，聊聊近況'],
    sofa_2: ['sofa', '角落沙發', '坐下來，聊聊近況'],
    ctbl_1: ['lowtable', '咖啡桌', '放杯飲料，慢慢聊'],
  };
}
