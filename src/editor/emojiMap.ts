/**
 * `:shortcode:` → emoji, for the `Emoji` syntax in `extendedSyntax.ts`.
 *
 * A curated set of the GitHub/Slack names people actually type, not the full
 * gemoji list, which is ~1,800 names and ~40 KB. Even this set is 3 KB gzipped,
 * so it is reached only through the dynamic import in `preview/render.ts`: the
 * preview shows `:rocket:` as typed and swaps in the emoji when this arrives.
 * A name that is not here stays as typed.
 *
 * A `Map`, not an object literal, so `:constructor:` and `:__proto__:` are
 * misses rather than prototype hits.
 */
export const EMOJI: ReadonlyMap<string, string> = new Map(
  Object.entries({
    // Faces
    smile: '😄', smiley: '😃', grinning: '😀', grin: '😁', laughing: '😆', joy: '😂',
    rofl: '🤣', sweat_smile: '😅', wink: '😉', blush: '😊', innocent: '😇',
    slightly_smiling_face: '🙂', upside_down_face: '🙃', relieved: '😌', heart_eyes: '😍',
    star_struck: '🤩', kissing_heart: '😘', yum: '😋', stuck_out_tongue: '😛',
    stuck_out_tongue_winking_eye: '😜', zany_face: '🤪', thinking: '🤔', thinking_face: '🤔',
    shushing_face: '🤫', zipper_mouth_face: '🤐', raised_eyebrow: '🤨', neutral_face: '😐',
    expressionless: '😑', no_mouth: '😶', smirk: '😏', unamused: '😒', roll_eyes: '🙄',
    grimacing: '😬', lying_face: '🤥', pensive: '😔', sleepy: '😪', sleeping: '😴',
    mask: '😷', nerd_face: '🤓', sunglasses: '😎', partying_face: '🥳', confused: '😕',
    worried: '😟', slightly_frowning_face: '🙁', open_mouth: '😮', astonished: '😲',
    flushed: '😳', pleading_face: '🥺', cry: '😢', sob: '😭', scream: '😱',
    confounded: '😖', disappointed: '😞', sweat: '😓', weary: '😩', tired_face: '😫',
    yawning_face: '🥱', triumph: '😤', rage: '😡', angry: '😠', exploding_head: '🤯',
    skull: '💀', poop: '💩', hankey: '💩', clown_face: '🤡', ghost: '👻', alien: '👽',
    robot: '🤖', see_no_evil: '🙈', hear_no_evil: '🙉', speak_no_evil: '🙊',

    // Hands and people
    '+1': '👍', thumbsup: '👍', '-1': '👎', thumbsdown: '👎', ok_hand: '👌',
    wave: '👋', clap: '👏', raised_hands: '🙌', pray: '🙏', handshake: '🤝',
    muscle: '💪', point_up: '☝️', point_down: '👇', point_left: '👈', point_right: '👉',
    v: '✌️', crossed_fingers: '🤞', metal: '🤘', call_me_hand: '🤙', fist: '✊',
    facepalm: '🤦', shrug: '🤷', eyes: '👀', brain: '🧠', writing_hand: '✍️',

    // Hearts and symbols
    heart: '❤️', orange_heart: '🧡', yellow_heart: '💛', green_heart: '💚',
    blue_heart: '💙', purple_heart: '💜', black_heart: '🖤', white_heart: '🤍',
    broken_heart: '💔', sparkling_heart: '💖', two_hearts: '💕', '100': '💯',
    fire: '🔥', sparkles: '✨', star: '⭐', star2: '🌟', boom: '💥', zap: '⚡',
    tada: '🎉', confetti_ball: '🎊', balloon: '🎈', gift: '🎁', trophy: '🏆',
    medal_sports: '🏅', first_place_medal: '🥇', crown: '👑', gem: '💎',
    zzz: '💤', dash: '💨', speech_balloon: '💬', thought_balloon: '💭',

    // Status and marks
    white_check_mark: '✅', heavy_check_mark: '✔️', check: '✔️', ballot_box_with_check: '☑️',
    x: '❌', negative_squared_cross_mark: '❎', heavy_multiplication_x: '✖️',
    warning: '⚠️', no_entry: '⛔', no_entry_sign: '🚫', stop_sign: '🛑',
    exclamation: '❗', heavy_exclamation_mark: '❗', question: '❓', grey_question: '❔',
    bangbang: '‼️', interrobang: '⁉️', information_source: 'ℹ️', bulb: '💡',
    red_circle: '🔴', orange_circle: '🟠', yellow_circle: '🟡', green_circle: '🟢',
    blue_circle: '🔵', purple_circle: '🟣', black_circle: '⚫', white_circle: '⚪',
    large_blue_diamond: '🔷', large_orange_diamond: '🔶', triangular_flag_on_post: '🚩',
    checkered_flag: '🏁', pushpin: '📌', round_pushpin: '📍', paperclip: '📎',
    link: '🔗', lock: '🔒', unlock: '🔓', key: '🔑', closed_lock_with_key: '🔐',
    bell: '🔔', no_bell: '🔕', mag: '🔍', label: '🏷️', bookmark: '🔖',
    hourglass: '⌛', hourglass_flowing_sand: '⏳', alarm_clock: '⏰', stopwatch: '⏱️',
    arrow_right: '➡️', arrow_left: '⬅️', arrow_up: '⬆️', arrow_down: '⬇️',
    arrows_counterclockwise: '🔄', repeat: '🔁', heavy_plus_sign: '➕',
    heavy_minus_sign: '➖', recycle: '♻️', new: '🆕', free: '🆓', up: '🆙',
    cool: '🆒', sos: '🆘', copyright: '©️', registered: '®️', tm: '™️',

    // Work and objects
    memo: '📝', pencil: '📝', pencil2: '✏️', page_facing_up: '📄', clipboard: '📋',
    spiral_notepad: '🗒️', notebook: '📓', book: '📖', books: '📚', bookmark_tabs: '📑',
    calendar: '📆', date: '📅', file_folder: '📁', open_file_folder: '📂',
    card_index_dividers: '🗂️', inbox_tray: '📥', outbox_tray: '📤', package: '📦',
    email: '📧', envelope: '✉️', mailbox: '📫', phone: '☎️', iphone: '📱',
    computer: '💻', desktop_computer: '🖥️', keyboard: '⌨️', floppy_disk: '💾',
    cd: '💿', camera: '📷', video_camera: '📹', tv: '📺', bar_chart: '📊',
    chart_with_upwards_trend: '📈', chart_with_downwards_trend: '📉',
    moneybag: '💰', dollar: '💵', euro: '💶', pound: '💷', credit_card: '💳',
    shopping_cart: '🛒', hammer: '🔨', wrench: '🔧', gear: '⚙️', hammer_and_wrench: '🛠️',
    toolbox: '🧰', test_tube: '🧪', microscope: '🔬', telescope: '🔭',
    bug: '🐛', rocket: '🚀', construction: '🚧', building_construction: '🏗️',
    art: '🎨', musical_note: '🎵', headphones: '🎧', microphone: '🎤',
    video_game: '🎮', dart: '🎯', jigsaw: '🧩', game_die: '🎲', mortar_board: '🎓',
    briefcase: '💼', handbag: '👜', shield: '🛡️', crystal_ball: '🔮',
    magic_wand: '🪄', battery: '🔋', electric_plug: '🔌', flashlight: '🔦',
    candle: '🕯️', scissors: '✂️', straight_ruler: '📏', triangular_ruler: '📐',
    newspaper: '📰', loudspeaker: '📢', mega: '📣', lipstick: '💄',

    // Nature, food and travel
    sunny: '☀️', cloud: '☁️', partly_sunny: '⛅', umbrella: '☔', snowflake: '❄️',
    rainbow: '🌈', ocean: '🌊', earth_africa: '🌍', earth_americas: '🌎',
    earth_asia: '🌏', globe_with_meridians: '🌐', crescent_moon: '🌙',
    seedling: '🌱', herb: '🌿', four_leaf_clover: '🍀', evergreen_tree: '🌲',
    deciduous_tree: '🌳', cactus: '🌵', rose: '🌹', sunflower: '🌻', tulip: '🌷',
    cherry_blossom: '🌸', fallen_leaf: '🍂', mushroom: '🍄',
    dog: '🐶', cat: '🐱', mouse: '🐭', rabbit: '🐰', fox_face: '🦊', bear: '🐻',
    panda_face: '🐼', koala: '🐨', tiger: '🐯', lion: '🦁', cow: '🐮', pig: '🐷',
    frog: '🐸', monkey: '🐒', chicken: '🐔', penguin: '🐧', bird: '🐦', owl: '🦉',
    unicorn: '🦄', bee: '🐝', butterfly: '🦋', snail: '🐌', turtle: '🐢',
    snake: '🐍', octopus: '🐙', whale: '🐳', dolphin: '🐬', fish: '🐟', crab: '🦀',
    apple: '🍎', green_apple: '🍏', banana: '🍌', lemon: '🍋', strawberry: '🍓',
    grapes: '🍇', watermelon: '🍉', peach: '🍑', cherries: '🍒', avocado: '🥑',
    carrot: '🥕', hot_pepper: '🌶️', bread: '🍞', cheese: '🧀', egg: '🥚',
    pizza: '🍕', hamburger: '🍔', fries: '🍟', taco: '🌮', sushi: '🍣', ramen: '🍜',
    cake: '🍰', birthday: '🎂', cookie: '🍪', doughnut: '🍩', chocolate_bar: '🍫',
    coffee: '☕', tea: '🍵', beer: '🍺', beers: '🍻', wine_glass: '🍷',
    champagne: '🍾', cocktail: '🍸', tropical_drink: '🍹',
    car: '🚗', taxi: '🚕', bus: '🚌', train: '🚆', bike: '🚲', airplane: '✈️',
    ship: '🚢', house: '🏠', office: '🏢', hospital: '🏥', school: '🏫',
    world_map: '🗺️', compass: '🧭', mountain: '⛰️', beach_umbrella: '🏖️',
    tent: '⛺', stars: '🌠', milky_way: '🌌',
  }),
);
