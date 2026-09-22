import { PixelScene } from './PixelScene.js';
import { paintKitchenRoom, paintKitchenProp } from './kitchenArt.js';

export class KitchenScene extends PixelScene {
  static THEME_ID = 'kitchen';
  static TITLE = '日常廚房';
  static SUBTITLE = 'THE EVERYDAY KITCHEN　 /　一起煮點好時光';
  static paintRoom = paintKitchenRoom;
  static paintProp = paintKitchenProp;
  static FALLBACK = ['herb', '香草盆栽', '聞到了嗎？是新鮮的香草！'];
  static ITEMS = {
    k_cart: ['cart', '食材推車', '今天的蔬菜送到了！'],
    k_island: ['island', '料理中島', '拌一碗新鮮沙拉'],
    k_dining: ['dining', '共享餐桌', '開飯了，一起坐下來吧'],
    k_stool_l: ['stool', '左側餐椅', '幫朋友留一個位置'],
    k_stool_r: ['stool', '右側餐椅', '幫朋友留一個位置'],
    k_pantry: ['pantry', '食材櫃', '麵粉、果醬、香料都在這裡'],
    k_dishes: ['dishes', '餐具櫃', '挑一個喜歡的盤子'],
    k_market: ['market', '蔬果籃', '挑選今天的季節蔬果'],
    spk_l: ['fridge', '冰箱', '新鮮食材，準備好了！'],
    spk_r: ['oven', '烤箱', '叮！麵包出爐了'],
    tbl_1: ['coffee', '咖啡機', '一杯剛好的日常'],
    tbl_2: ['sink', '洗手台', '嘩啦啦，洗乾淨了'],
    tbl_3: ['pot', '湯鍋', '咕嚕咕嚕，暖湯時間'],
    sofa_1: ['board', '備料桌', '切一點蔬菜，添一點色彩'],
    sofa_2: ['bread', '烘焙桌', '一起揉一份好心情'],
    ctbl_1: ['tea', '茶桌', '坐下來，分享今天吧'],
  };
}
