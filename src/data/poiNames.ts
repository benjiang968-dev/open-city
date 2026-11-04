// Invented business names for map POIs. The OSM importer (scripts/importOsm.mjs) never copies a real business or
// building name; each POI only carries its OSM category (cat, e.g. "amenity=cafe"), and the game names it from here.
// Every name below is made up for Open City: no real brands, chains, local businesses or brand colours.
// Keys are OSM "key=value" categories; POI_FALLBACK covers any other value of the same top-level key.

export const POI_NAMES: Record<string, readonly string[]> = {
  // Food and drink
  'amenity=cafe': ['Daily Grind', 'Steam & Saucer', 'Crema Corner', 'Half Past Latte', 'Kettle & Crumb', 'The Slow Pour'],
  'amenity=restaurant': ['Copper Spoon', 'The Long Table', 'Brick & Basil', 'Saltgrass Kitchen', 'Lantern House', 'Fennel & Fig'],
  'amenity=fast_food': ['Feast Food', 'Bun Voyage', 'Quickbite Counter', 'Snack Attack Grill', 'Hot Paper Bag'],
  'amenity=bar': ['The Tipsy Heron', 'Last Orders', 'The Copper Still', 'Velvet Hour', 'Ninth Pour'],
  'amenity=pub': ['The Crooked Kettle', 'Ploughshare Arms', 'The Lamp & Ladder', 'The Old Tow Rope', 'The Muddy Boot'],
  'amenity=ice_cream': ['Cone Zone', 'Scoopsmith', 'Frosty Fold', 'Sundae Service', 'Polar Parlour'],
  'amenity=food_court': ['The Food Hall', 'Twelve Counters', 'Lunch Yard', 'Market Tables'],
  'amenity=nightclub': ['Bassment', 'Neon Moth', 'Afterglow', 'The Strobe Loft'],
  'shop=bakery': ['Crumb Theory', 'Proof Bakehouse', 'Butter & Rye', 'Knead to Know', 'Sweet Crust'],
  'shop=deli': ['Slice & Stack', 'Rye Society', 'The Cured Corner', 'Pickled Pepper Deli'],
  'shop=confectionery': ['Sugar Mouse', 'Truffle Box', 'Gumdrop Lane', 'Toffee Tin'],
  'shop=chocolate': ['Bittersweet', 'The Cacao Room', 'Melt', 'Nib & Bean'],
  'shop=alcohol': ['Cork & Cask', 'Uncorked', 'Barrel Room', 'Bottle Bay'],
  'shop=wine': ['Grape Escape', 'Vintage Shelf', 'Red & White', 'The Decanter'],
  'shop=coffee': ['Roast Ledger', 'Green Bean Store', 'Grounds for Joy', 'The Hopper'],
  // Groceries
  'shop=supermarket': ['Green Basket Grocers', 'Pantry Plus', 'Aisle Nine', 'Larder & Co.', 'Full Trolley'],
  'shop=convenience': ['Corner Mart', 'Open Late Market', 'Pocket Grocery', 'Handy Shop', 'Tick Tock Mart'],
  'shop=greengrocer': ['Root & Leaf', 'The Turnip Stand', 'Orchard Row', 'Fresh Pickings'],
  'shop=butcher': ['Cleaver & Sons', 'Prime Cut', 'The Chop Block', 'Marrow Meats'],
  // Fashion and personal care
  'shop=clothes': ['Threadz', 'Hem & Hue', 'Loom Room', 'Cotton Corner', 'Button Up'],
  'shop=shoes': ['Heel & Toe', 'Footnote', 'Lace Up', 'Bootstrap Shoes'],
  'shop=jewelry': ['Gilt Edge', 'Facet & Clasp', 'Silver Thread', 'Gem Lantern', 'Karat Corner'],
  'shop=bag': ['Carryall', 'Tote Story', 'Strap & Buckle', 'Satchel Row'],
  'shop=boutique': ['Maison Moth', 'Little Rare', 'Pressed Linen', 'Fold Studio'],
  'shop=beauty': ['Polish & Petal', 'Velvet Skin Studio', 'Lash Lane', 'Dewdrop Beauty'],
  'shop=cosmetics': ['Blush Box', 'Rouge Room', 'Powder Puff', 'Tint & Tone'],
  'shop=hairdresser': ['Mane Street', 'Clip Joint', 'Snip Snap', 'The Parting', 'Fringe Benefits'],
  'shop=optician': ['Clear View Optics', 'Lens & Frame', 'Eyeline', 'Twenty Twenty'],
  'shop=perfumery': ['Scent Note', 'Atomiser', 'Top Note', 'Amber & Oud'],
  'shop=tattoo': ['Ink Well Studio', 'Fine Line', 'Black Anchor Tattoo', 'Second Skin Ink'],
  // Home, hobby and gifts
  'shop=books': ['Dog-Ear Books', 'Spine & Margin', 'Paper Lantern Books', 'Marginalia', 'Inkwell Books'],
  'shop=gift': ['Knick Knack Shack', 'Tokens & Trinkets', 'Wrapped', 'Little Gifts Co.', 'Souvenir Shelf'],
  'shop=furniture': ['Settle & Sit', 'Oak & Ottoman', 'Roomworks', 'Drawer & Dresser'],
  'shop=interior_decoration': ['Wallflower Interiors', 'Lamp & Linen', 'Nook', 'Cornice'],
  'shop=antiques': ['Dust & Patina', 'Time Worn Antiques', 'Second Century', 'Attic Finds'],
  'shop=art': ['Canvas & Co.', 'Brushwork', 'Easel House', 'Print Room'],
  'shop=florist': ['Stem & Petal', 'Bloom Room', 'Wild Bunch', 'Posy Shop'],
  'shop=hardware': ['Nuts & Bolts', 'Toolbox Hardware', 'Hinge & Handle', 'The Fix Shop'],
  'shop=electronics': ['Circuit Corner', 'Volt Box', 'Plug & Play', 'Diode Depot'],
  'shop=mobile_phone': ['Signal Bar', 'Pocket Tech', 'Screen Savers', 'Ringtone'],
  'shop=bicycle': ['Spoke & Chain', 'Two Wheels', 'Pedal Pushers', 'Gear Ratio'],
  'shop=sports': ['Fieldhouse Sports', 'Final Whistle', 'Trackside Sports', 'Kit Bag'],
  'shop=outdoor': ['Trailhead Outfitters', 'Basecamp', 'Ridge & River', 'Tent Pole'],
  'shop=toys': ['Toy Chest', 'Spinning Top', 'Marble Jar', 'Play Box'],
  'shop=music': ['Vinyl Groove', 'B-Side Records', 'Treble Clef', 'Needle Drop'],
  'shop=pet': ['Paws & Whiskers', 'Fetch', 'Tail Wag', 'Kibble Corner'],
  'shop=tobacco': ['Ember & Leaf', 'Smoke Ring', 'Pipe Dream', 'Ash & Oak'],
  'shop=dry_cleaning': ['Fresh Press', 'Crease Lightning', 'Spotless', 'Steam Team'],
  'shop=laundry': ['Spin Cycle', 'Suds Club', 'Clean Slate Laundry', 'Tumble'],
  'shop=stationery': ['Paper Trail', 'Ink & Quill', 'Pen Pals', 'Ruled Lines'],
  'shop=variety_store': ['Everything Shelf', 'Bits & Bobs', 'Dollar Drawer', 'Odds & Ends'],
  'shop=department_store': ['Hartwell & Finch', 'The Emporium', 'Five Floors', 'Grand Arcade'],
  // Vehicles
  'shop=car': ['Gearshift Motors', 'Open Road Autos', 'Chrome & Co. Motors', 'Mileage Motors', "Dealer's Choice Cars"],
  'shop=car_repair': ['Torque & Sons Auto', 'Wrench Works', 'Busted Bumper Garage', 'Spark & Piston', 'Axle Alley'],
  'shop=car_parts': ['Part Bin', 'Bolt Bucket', 'Spare Parts Depot', 'Carburettor Corner'],
  'amenity=fuel': ['Pump & Go', 'Fillwell', 'Tankside Fuel', 'Octane Corner'],
  'amenity=car_wash': ['Bubble Bay', 'Shine Station', 'Soap & Shammy', 'Rinse Cycle'],
  'amenity=car_rental': ['Keyring Rentals', 'Wheels for Hire', 'Borrowed Miles', 'Spare Key Car Hire'],
  'amenity=boat_rental': ['Paddle & Oar Rentals', 'Keel Hire', 'Rowlock Boats', 'Slipway Kayaks'],
  // Money, health and services
  'amenity=bank': ['First Vault', 'Ledgerline Bank', 'Granite Trust', 'Harbourstone Savings', 'Coinwell Bank'],
  'amenity=atm': ['Cash Point', 'Quick Cash', 'Vault Express', 'Coin Slot'],
  'amenity=pharmacy': ['Pillbox', 'Remedy Row', 'Tonic & Tablet', 'Mortar & Pestle Pharmacy', 'Wellspring Drugs'],
  'amenity=post_office': ['Post & Parcel', 'Stamp House', 'Letterbox Office', 'Sorting Room'],
  'amenity=dentist': ['Bright Bite Dental', 'Clean Smile Studio', 'Enamel & Co.', 'Floss Boss'],
  'amenity=doctors': ['Rowhouse Medical', 'Healwell Doctors', 'Linden Family Practice', 'Steady Pulse Clinic'],
  'amenity=clinic': ['Riverside Walk-In', 'Mendwell Clinic', 'St. Wren Medical', 'First Aid Station'],
  'amenity=hospital': ['St. Alder General', 'Riverbank Medical Centre', 'Kestrel Hill Hospital', 'Brightwater General'],
  'amenity=veterinary': ['Paws Vet', 'Feather & Fur Vets', 'Whisker Clinic', 'Barkley Animal Hospital'],
  'amenity=police': ['Precinct 4', 'Precinct 7', 'Westside Station', 'River Patrol Office'],
  'amenity=fire_station': ['Engine House 41', 'Ladder Company 19', 'Firehouse 46', 'Station 52'],
  // Learning, faith and culture
  'amenity=school': ['Larkspur Elementary', 'Copperleaf Academy', 'Northgate Middle School', 'Stonebrook School', 'Riverbend Prep'],
  'amenity=kindergarten': ['Little Acorns', 'Building Blocks Nursery', 'Tiny Steps', 'Crayon Club'],
  'amenity=university': ['Fernhollow University', 'Brightmoor College', 'Westhaven Institute', 'Quarrystone University'],
  'amenity=college': ['Ashgrove College', 'Calderwood College', 'Tannery Arts College', 'Linwood Technical College'],
  'amenity=library': ['Quillstone Library', 'The Reading Room', 'Lamp Street Library', 'The Stacks'],
  'amenity=place_of_worship': ["St. Wren's Church", 'Grace Hill Chapel', 'Riverside Fellowship', 'Old Stone Meeting House', 'Cedar Street Congregation'],
  'amenity=theatre': ['The Footlights', 'Curtain Call Playhouse', 'Gaslight Theatre', 'The Proscenium'],
  'amenity=cinema': ['Marquee Twelve', 'The Flicker House', 'Reel Palace', 'Starlight Screens'],
  'amenity=arts_centre': ['The Kiln', 'Open Studio', 'Workshop Gallery', 'Assembly Rooms'],
  'amenity=community_centre': ['Neighbourhood Hall', 'The Commons', 'Rowhouse Community Centre', 'Gathering Place'],
  // Tourism
  'tourism=hotel': ['Lamplighter Hotel', 'Tidewater Suites', 'Cobblestone Inn', 'The Brass Lantern', 'Hotel Meridiem'],
  'tourism=guest_house': ['Ivy Door Guest House', 'Rowhouse Rooms', 'The Spare Room', 'Blue Shutter B&B'],
  'tourism=museum': ['Museum of Small Things', 'Hall of Curiosities', 'River Heritage Museum', 'The Ironworks Gallery', 'Cabinet of Maps'],
  'tourism=gallery': ['The White Wall', 'Frame & Hang', 'Gallery Nine', 'Sketchbook Gallery'],
  'tourism=attraction': ['The Old Lookout', 'Lantern Steps', 'The Wishing Wall', "Ferryman's Corner"],
  'tourism=viewpoint': ['Gull Point', 'River Overlook', 'Long View', 'Sunset Rail'],
  // Leisure
  'leisure=fitness_centre': ['Rep Room', 'Lift Lab', 'Core & Cardio', 'Muscle Mill', 'Ironbound Gym'],
  'leisure=sports_centre': ['Fieldhouse Arena', 'Courtside Centre', 'The Rec', 'Playmaker Sports Hall'],
  'leisure=marina': ['Driftline Marina', 'Mooring Row', 'Riverlight Boat Club', 'Slack Water Docks'],
  'leisure=dance': ['Two Left Feet', 'Studio Tango', 'Spin & Step', 'Ballroom Six'],
  // Offices
  'office=company': ['Meridian Partners', 'Northlight Media', 'Quayside Holdings', 'Copperfield Group'],
  'office=lawyer': ['Copperfield & Vane', 'Ashby Hale LLP', 'Statute & Pike', 'Whitlock Legal'],
  'office=estate_agent': ['Front Door Realty', 'Brick & Key Estates', 'Open House Agents', 'Doorstep Property'],
  'office=government': ['Bureau of Permits', 'Records Office', 'Department of Small Things', 'Civic Annex'],
  'office=it': ['Byteworks', 'Patch Notes Ltd', 'Null Pointer Labs', 'Tidy Stack Systems'],
  'office=insurance': ['Safe Harbour Insurance', 'Umbrella & Co.', 'Rainy Day Mutual', 'Steady Keel Cover'],
  'office=diplomatic': ['Embassy of Veloria', 'Consulate of Marenland', 'Mission of Kestovia', 'Embassy of the Amber Isles'],
};

/** Names for any category not listed above, by OSM top-level key. */
export const POI_FALLBACK: Record<string, readonly string[]> = {
  amenity: ['The Local', 'Corner Spot', 'Neighbourhood Place', 'Number Nine'],
  shop: ['The Little Shop', 'Main Street Goods', 'Market Row', 'Shopfront 21'],
  tourism: ['Visitor Point', 'Riverside Stop', 'Wayfarer Spot', 'The Landmark'],
  leisure: ['Rec Room', 'The Clubhouse', 'Leisure Hall', 'Free Time'],
  office: ['Suite 200', 'Third Floor Offices', 'Harbour House Offices', 'Unit 12 Studios'],
  craft: ['Workshop No. 5', 'Makers Yard', 'The Bench', 'Hand & Tool'],
  healthcare: ['Wellness Point', 'Healwell Centre', 'Care Corner', 'Mendwell Practice'],
  historic: ['Old Marker', 'Heritage Stone', 'The Old Plaque', 'Founders Mark'],
};

/** Deterministic original name for a POI: same category and id always give the same name. */
export function poiName(cat: string, id: string | number): string {
  const list = POI_NAMES[cat] ?? POI_FALLBACK[cat.split('=')[0]] ?? POI_FALLBACK.amenity;
  const s = String(id);
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return list[(h >>> 0) % list.length];
}
